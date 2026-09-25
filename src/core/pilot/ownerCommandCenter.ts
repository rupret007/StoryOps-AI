import { assessCompanyConfiguration } from '@/domain/companyConfiguration';
import type { DemoState, DemoVisit, LiveTransactionalDelivery } from '@/state/model';

export type OwnerActionKind = 'hold' | 'decision' | 'follow_up';

export interface OwnerActionEntity {
  label: string;
  href: string;
}

export interface OwnerActionItem {
  id: string;
  priority: 'P0' | 'P1' | 'P2';
  kind: OwnerActionKind;
  title: string;
  fact: string;
  recommendation: string;
  blockedBy?: string;
  source: string;
  href: string;
  entities?: OwnerActionEntity[];
}

export type OwnerCommandFreshness = 'sandbox' | 'current' | 'offline' | 'untimed';

export type OwnerTodayStatus = 'fixture' | 'dated' | 'unknown' | 'incomplete';

export interface OwnerCommandGlance {
  freshness: OwnerCommandFreshness;
  countsKnown: boolean;
  headline: string;
  caveat: string;
  clockLabel: string;
  holds: number | null;
  decisions: number | null;
  followUps: number | null;
  p0Holds: number | null;
}

export interface OwnerCommandCenterProjection {
  mode: 'sandbox' | 'authenticated';
  sourcedAt: string;
  freshness: OwnerCommandFreshness;
  glance: OwnerCommandGlance;
  today: {
    localDate?: string;
    timeZone: string;
    visits: DemoState['visits'];
    evidenceFacts: string[];
    status: OwnerTodayStatus;
    missingExactStarts: number;
  };
  actions: OwnerActionItem[];
  nextAction?: OwnerActionItem;
  holds: OwnerActionItem[];
  decisions: OwnerActionItem[];
  followUps: OwnerActionItem[];
  unknowns: string[];
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
  | 'incidents'
  | 'invoices'
  | 'traces'
  | 'integrations'
  | 'customerQuoteAccepted'
  | 'depositPaid'
  | 'reviewRequested'
  | 'recurringPlanActive'
  | 'recurringDueWork'
  | 'offlineQueue'
  | 'live'
  | 'online'
>;

export function pickNextOwnerAction(actions: OwnerActionItem[]): OwnerActionItem | undefined {
  return (
    actions.find((action) => action.priority === 'P0' && action.kind === 'hold') ??
    actions.find((action) => action.priority === 'P0') ??
    actions.find((action) => action.priority === 'P1' && action.kind === 'hold') ??
    actions[0]
  );
}

const ownerActionSurfaces: ReadonlyArray<readonly [string, string]> = [
  ['/operations#safety', 'Safety & incidents'],
  ['/operations#recurring', 'Recurring care'],
  ['/operations', 'Operations'],
  ['/estimates/new', 'New estimate'],
  ['/estimates/', 'Estimate'],
  ['/setup', 'Owner configuration'],
  ['/field', 'Field'],
  ['/dispatch', 'Dispatch'],
  ['/finance', 'Finance'],
  ['/approvals', 'Approvals'],
  ['/pipeline', 'Pipeline'],
  ['/portal', 'Customer portal'],
  ['/integrations', 'Integrations'],
  ['/office', 'AI office'],
];

export function ownerActionSurface(href: string): string {
  return ownerActionSurfaces.find(([prefix]) => href.startsWith(prefix))?.[1] ?? 'Workspace';
}

export function explainNextOwnerAction(action: OwnerActionItem): string {
  if (action.kind === 'hold' && action.priority === 'P0') {
    return 'This hold stops work. Handle it before any decision or follow-up.';
  }
  if (action.kind === 'hold') {
    return action.priority === 'P1'
      ? 'No P0 item is waiting. This hold is the next thing that still blocks a safe step.'
      : 'No higher-priority item is waiting. This hold still blocks a safe step.';
  }
  if (action.priority === 'P0') {
    return 'This is the highest-priority item. No P0 hold is waiting in front of it.';
  }
  if (action.kind === 'decision') {
    return 'No hold is in front of this. It needs your yes or no on the exact record.';
  }
  return 'No hold is in front of this. This follow-up can wait behind anything that stops work.';
}

export function ownerActionGlanceLine(action: OwnerActionItem): string {
  const records = action.entities?.length ?? 0;
  const named =
    records === 0
      ? 'No named record on this line.'
      : records === 1
        ? `Record: ${action.entities?.[0]?.label}.`
        : `${records} named records.`;
  if (action.kind === 'hold' && action.priority === 'P0') return `Stops work. ${named}`;
  if (action.kind === 'hold') return `Still blocks a safe step. ${named}`;
  if (action.kind === 'decision') return `Needs your yes or no. ${named}`;
  return `Can wait behind holds. ${named}`;
}

export function deriveOwnerCommandGlance(input: {
  freshness: OwnerCommandFreshness;
  sourcedAt: string;
  holds: readonly OwnerActionItem[];
  decisions: readonly OwnerActionItem[];
  followUps: readonly OwnerActionItem[];
  nextAction?: OwnerActionItem;
}): OwnerCommandGlance {
  const countsKnown = input.freshness === 'sandbox' || input.freshness === 'current';
  const clockLabel =
    input.freshness === 'sandbox'
      ? 'Sandbox fixture. Not a live tally.'
      : input.freshness === 'current'
        ? `Server time ${input.sourcedAt}.`
        : input.freshness === 'offline'
          ? 'Offline. The last read is not a live tally.'
          : 'Server time unavailable.';
  const holds = countsKnown ? input.holds.length : null;
  const decisions = countsKnown ? input.decisions.length : null;
  const followUps = countsKnown ? input.followUps.length : null;
  const p0Holds = countsKnown
    ? input.holds.filter((action) => action.priority === 'P0').length
    : null;

  if (!countsKnown) {
    return {
      freshness: input.freshness,
      countsKnown,
      headline: 'This command center is not current.',
      caveat:
        input.freshness === 'offline'
          ? 'This device is offline. Do not read these rows as a live tally, and do not read an empty list as all clear.'
          : 'Server time is missing. Do not read an empty list as all clear. Refresh the workspace before you act.',
      clockLabel,
      holds,
      decisions,
      followUps,
      p0Holds,
    };
  }

  const next = input.nextAction;
  if (!next) {
    return {
      freshness: input.freshness,
      countsKnown,
      headline: 'Nothing in this projection is waiting.',
      caveat: 'This is not a clearance. Hidden records and provider state can still block work.',
      clockLabel,
      holds,
      decisions,
      followUps,
      p0Holds,
    };
  }

  if ((p0Holds ?? 0) > 0) {
    const stopping = p0Holds === 1 ? '1 hold stops work.' : `${p0Holds} holds stop work.`;
    const behind = (holds ?? 0) - (p0Holds ?? 0);
    const extra =
      behind > 0 ? ` ${behind} more ${behind === 1 ? 'hold is' : 'holds are'} behind it.` : '';
    return {
      freshness: input.freshness,
      countsKnown,
      headline: stopping,
      caveat: `First: ${next.title}.${extra} This is not a clearance of hidden records.`,
      clockLabel,
      holds,
      decisions,
      followUps,
      p0Holds,
    };
  }

  const headline =
    next.kind === 'decision'
      ? 'No hold stops work. A decision is waiting.'
      : next.kind === 'follow_up'
        ? 'No hold stops work. A follow-up is waiting.'
        : 'A hold still blocks the next safe step.';
  return {
    freshness: input.freshness,
    countsKnown,
    headline,
    caveat: `${next.title}. This is not a clearance of hidden records.`,
    clockLabel,
    holds,
    decisions,
    followUps,
    p0Holds,
  };
}

export function ownerTodayVisitEmptyCopy(
  today: OwnerCommandCenterProjection['today'],
  freshness: OwnerCommandFreshness,
): { heading: string; detail: string } {
  if (today.status === 'unknown' || freshness === 'untimed') {
    return {
      heading: 'Today is unknown',
      detail:
        'Server time is missing. An empty list is not an empty day, and it does not claim future capacity.',
    };
  }
  if (freshness === 'offline') {
    return {
      heading: 'No visits on the last server day',
      detail: `The last server day was ${today.localDate ?? 'unknown'}. This device is offline, so this is not a live empty day.`,
    };
  }
  if (today.status === 'incomplete') {
    const count = today.missingExactStarts;
    return {
      heading: 'Today is incomplete',
      detail: `${count} role-visible visit${count === 1 ? ' has' : 's have'} no exact server start. An empty list is not an empty day.`,
    };
  }
  return {
    heading: 'No company-local visits today',
    detail:
      'This uses exact server visit starts in the company timezone. It does not claim future capacity.',
  };
}

export function ownerTodayVisitGapNote(
  today: OwnerCommandCenterProjection['today'],
  freshness: OwnerCommandFreshness,
): string | undefined {
  if (freshness === 'offline' && today.visits.length > 0) {
    return 'Offline. These visits use the last server time, not a live calendar.';
  }
  if (today.status !== 'incomplete' || today.visits.length === 0) return undefined;
  const count = today.missingExactStarts;
  return `${count} role-visible visit${count === 1 ? ' has' : 's have'} no exact server start and ${
    count === 1 ? 'is' : 'are'
  } left off this day.`;
}

function transactionalDeliveryIsHeld(delivery: LiveTransactionalDelivery): boolean {
  return (
    delivery.manualReconciliationRequired ||
    delivery.status === 'submitted_unknown' ||
    delivery.status === 'failed'
  );
}

function collectHeldDeliveries(state: OwnerProjectionState): OwnerActionEntity[] {
  const seen = new Set<string>();
  const held: OwnerActionEntity[] = [];
  const add = (
    delivery: LiveTransactionalDelivery | undefined,
    label: string,
    href: string,
  ): void => {
    if (!delivery || !transactionalDeliveryIsHeld(delivery) || seen.has(delivery.id)) return;
    seen.add(delivery.id);
    held.push({
      label: `${label} · ${delivery.status.replaceAll('_', ' ')}`,
      href,
    });
  };

  add(state.live?.quoteDelivery, 'Quote delivery', `/estimates/${state.estimate.id}`);
  add(state.live?.onMyWayDelivery, 'On-my-way delivery', '/field');
  for (const [visitId, reference] of Object.entries(state.live?.fieldVisitReferences ?? {})) {
    const visit = state.visits.find((candidate) => candidate.id === visitId);
    add(
      reference.onMyWayDelivery,
      visit ? `${visit.jobNumber} on-my-way` : 'On-my-way delivery',
      '/field',
    );
  }
  return held;
}

function visitEntities(visits: DemoVisit[], href: string): OwnerActionEntity[] {
  return visits.map((visit) => ({ label: visit.jobNumber, href }));
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
  const rawServerTime = state.live?.serverTime?.trim() ?? '';
  const localDate = rawServerTime ? localDateKey(rawServerTime, timeZone) : undefined;
  const freshness: OwnerCommandFreshness = !live
    ? 'sandbox'
    : state.online !== true
      ? 'offline'
      : !rawServerTime || !localDate
        ? 'untimed'
        : 'current';
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
    const routeIsCurrent =
      visit.route.provider === 'vroom' &&
      visit.route.evidenceMode === 'live' &&
      visit.route.freshness === 'current' &&
      typeof visit.route.feasible === 'boolean' &&
      Boolean(visit.route.checkedAt);
    if (routeIsCurrent) {
      todayEvidenceFacts.push(
        `${visit.jobNumber} route is ${visit.route.feasible ? 'feasible' : 'not feasible'} from current VROOM evidence checked ${visit.route.checkedAt}${
          visit.route.driveMinutes === undefined
            ? '.'
            : `; drive time is ${visit.route.driveMinutes} minutes.`
        }`,
      );
    } else {
      visitEvidenceUnknowns.push(
        `${visit.jobNumber} route and travel time are unknown until current live VROOM evidence is bound to the visit.`,
      );
    }

    const weatherIsCurrent =
      visit.weather.provider === 'nws' &&
      visit.weather.evidenceMode === 'live' &&
      visit.weather.freshness === 'current' &&
      Boolean(visit.weather.checkedAt) &&
      Boolean(visit.weather.policyDisposition);
    if (weatherIsCurrent) {
      todayEvidenceFacts.push(
        `${visit.jobNumber} weather is ${visit.weather.policyDisposition?.replaceAll('_', ' ')} under current NWS policy evidence checked ${visit.weather.checkedAt}.`,
      );
    } else {
      visitEvidenceUnknowns.push(
        `${visit.jobNumber} service-window weather is unknown until current live NWS policy evidence is bound to the visit.`,
      );
    }
  }
  const missingExactStarts = live
    ? state.visits.filter((visit) => !state.live?.fieldVisitReferences?.[visit.id]?.visitStartsAt)
        .length
    : 0;
  if (live && localDate && missingExactStarts > 0) {
    visitEvidenceUnknowns.push(
      'At least one role-visible visit lacks an exact server-projected start, so its company-local today status is unknown.',
    );
  }
  const todayStatus: OwnerTodayStatus = !live
    ? 'fixture'
    : !localDate
      ? 'unknown'
      : missingExactStarts > 0
        ? 'incomplete'
        : 'dated';

  if (!state.companyConfiguration) {
    actions.push({
      id: 'configuration-missing',
      priority: 'P0',
      kind: 'hold',
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
      kind: 'hold',
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
      kind: 'hold',
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
      kind: 'decision',
      title: 'Review held actions',
      fact: `${pendingApprovals.length} exact-payload approval${pendingApprovals.length === 1 ? ' is' : 's are'} pending.`,
      recommendation: 'Approve or reject each exact payload; do not approve from a summary alone.',
      blockedBy: 'Owner decision',
      source: `${sourcePrefix} · approval records`,
      href: '/approvals',
      entities: pendingApprovals.map((approval) => ({
        label: approval.title,
        href: '/approvals',
      })),
    });
  }

  if (
    ['draft', 'ready'].includes(state.estimate.status) ||
    !state.estimate.photoEvidence.humanVerified
  ) {
    actions.push({
      id: 'estimate-evidence',
      priority: 'P1',
      kind: 'hold',
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
      entities: [{ label: state.estimate.estimateNumber, href: `/estimates/${state.estimate.id}` }],
    });
  } else if (state.estimate.status === 'approved') {
    actions.push({
      id: 'approved-quote-draft',
      priority: 'P1',
      kind: 'decision',
      title: 'Publish the approved quote',
      fact: `${state.estimate.estimateNumber} is within policy but has not entered the quote-awaiting-customer stage.`,
      recommendation:
        'Review the exact customer preview, publish it to the portal, then record each delivery attempt separately.',
      blockedBy: 'Explicit quote publication',
      source: `${sourcePrefix} · estimate and quote projection`,
      href: `/estimates/${state.estimate.id}`,
      entities: [{ label: state.estimate.estimateNumber, href: `/estimates/${state.estimate.id}` }],
    });
  } else if (state.estimate.status === 'quoted' && !state.customerQuoteAccepted) {
    actions.push({
      id: 'quote-awaiting-customer',
      priority: 'P2',
      kind: 'follow_up',
      title: 'Quote awaits customer action',
      fact: `${state.estimate.estimateNumber} is published; no authenticated acceptance is projected.`,
      recommendation:
        'Inspect delivery/reconciliation evidence and follow up only through a currently consented channel.',
      source: `${sourcePrefix} · quote acceptance and communication projection`,
      href: '/portal',
      entities: [{ label: state.estimate.estimateNumber, href: '/portal' }],
    });
  }

  if (state.customerQuoteAccepted && !state.depositPaid) {
    actions.push({
      id: 'deposit-awaiting-reconciliation',
      priority: 'P0',
      kind: 'hold',
      title: 'Deposit is not proven',
      fact: 'The quote is accepted, but no reconciled provider payment is projected.',
      recommendation:
        'Reconcile the provider record; do not confirm a visit from a checkout redirect or pending event.',
      blockedBy: 'Signed provider payment evidence',
      source: `${sourcePrefix} · quote acceptance and payment projection`,
      href: '/finance',
    });
  }

  const newLeads = state.leads.filter((lead) => lead.stage === 'new');
  if (newLeads.length > 0) {
    actions.push({
      id: 'new-leads',
      priority: 'P1',
      kind: 'follow_up',
      title: 'Qualify new leads',
      fact: `${newLeads.length} role-visible lead${newLeads.length === 1 ? ' is' : 's are'} still new.`,
      recommendation:
        'Verify contact, consent, property, service scope, and unknowns before estimating.',
      source: `${sourcePrefix} · lead stage projection`,
      href: '/pipeline',
      entities: newLeads.map((lead) => ({ label: lead.name, href: '/pipeline' })),
    });
  }

  const weatherHolds = state.visits.filter((visit) => visit.status === 'weather_hold');
  if (weatherHolds.length > 0) {
    actions.push({
      id: 'weather-held-visits',
      priority: 'P0',
      kind: 'hold',
      title: 'Visits are on weather hold',
      fact: `${weatherHolds.length} role-visible visit${weatherHolds.length === 1 ? ' is' : 's are'} blocked by the current visit state: ${weatherHolds
        .map((visit) => visit.jobNumber)
        .join(', ')}.`,
      recommendation:
        'Review fresh NWS, route, capacity, and customer-reschedule evidence before proposing a new window.',
      blockedBy: 'Fresh service-window evidence and dispatcher decision',
      source: `${sourcePrefix} · visit status projection`,
      href: '/dispatch',
      entities: visitEntities(weatherHolds, '/dispatch'),
    });
  }

  const pausedFieldVisits = state.visits.filter((visit) => visit.status === 'paused');
  if (pausedFieldVisits.length > 0) {
    actions.push({
      id: 'field-evidence-blocked',
      priority: 'P0',
      kind: 'hold',
      title: 'Field work is paused',
      fact: `${pausedFieldVisits.length} visit${pausedFieldVisits.length === 1 ? ' is' : 's are'} paused and cannot be completed: ${pausedFieldVisits
        .map((visit) => visit.jobNumber)
        .join(', ')}.`,
      recommendation:
        'Open the field packet and resolve checklist, media, signature, material/SDS, notes, or incident blockers.',
      blockedBy: 'Durably reconciled completion evidence',
      source: `${sourcePrefix} · visit and field packet projection`,
      href: '/field',
      entities: visitEntities(pausedFieldVisits, '/field'),
    });
  }

  const openIncidents = state.incidents.filter((incident) => incident.status === 'open');
  if (openIncidents.length > 0) {
    actions.push({
      id: 'open-incidents',
      priority: 'P0',
      kind: 'hold',
      title: 'Open incidents pause automation',
      fact: `${openIncidents.length} open incident${openIncidents.length === 1 ? '' : 's'} ${
        openIncidents.length === 1 ? 'has' : 'have'
      } paused affected automation: ${openIncidents
        .map((incident) => `${incident.jobNumber} · ${incident.kind.replaceAll('_', ' ')}`)
        .join('; ')}.`,
      recommendation:
        'Review the exact evidence packet on Safety & incidents. Do not admit fault, contact insurers, or send incident communications from a summary.',
      blockedBy: 'Owner incident review and factual closure',
      source: `${sourcePrefix} · incident records`,
      href: '/operations#safety',
      entities: openIncidents.map((incident) => ({
        label: `${incident.jobNumber} · ${incident.kind.replaceAll('_', ' ')}`,
        href: '/operations#safety',
      })),
    });
  }

  const fieldChangeRequests = state.visits.flatMap((visit) =>
    (visit.changeRequests ?? [])
      .filter((request) => ['submitted', 'reviewing'].includes(request.status))
      .map((request) => ({ visit, request })),
  );
  if (fieldChangeRequests.length > 0) {
    actions.push({
      id: 'field-change-requests',
      priority: 'P1',
      kind: 'hold',
      title: 'Field change requests need office review',
      fact: `${fieldChangeRequests.length} field change request${
        fieldChangeRequests.length === 1 ? ' is' : 's are'
      } still open: ${fieldChangeRequests
        .map(
          ({ visit, request }) => `${visit.jobNumber} · ${request.reasonCode.replaceAll('_', ' ')}`,
        )
        .join('; ')}.`,
      recommendation:
        'Review the exact reason code and summary. A field note is not booking, payment, or completion evidence.',
      blockedBy: 'Staff review of the submitted field change',
      source: `${sourcePrefix} · visit field-change records`,
      href: '/field',
      entities: fieldChangeRequests.map(({ visit, request }) => ({
        label: `${visit.jobNumber} · ${request.reasonCode.replaceAll('_', ' ')}`,
        href: '/field',
      })),
    });
  }

  const pendingOfflinePackets = state.offlineQueue.filter((packet) =>
    ['queued', 'syncing', 'failed'].includes(packet.status),
  );
  const failedOfflinePackets = pendingOfflinePackets.filter((packet) => packet.status === 'failed');
  if (pendingOfflinePackets.length > 0) {
    actions.push({
      id: 'offline-packet-holds',
      priority: failedOfflinePackets.length > 0 ? 'P0' : 'P1',
      kind: 'hold',
      title:
        failedOfflinePackets.length > 0
          ? 'Offline packets failed to reconcile'
          : 'Offline packets are waiting to reconcile',
      fact: `${pendingOfflinePackets.length} device packet${
        pendingOfflinePackets.length === 1 ? ' is' : 's are'
      } not reconciled${
        failedOfflinePackets.length > 0 ? `; ${failedOfflinePackets.length} failed` : ''
      }.`,
      recommendation:
        failedOfflinePackets.length > 0
          ? 'Open field recovery and inspect the failed packet. Do not invent completion from local storage.'
          : 'Refresh the server workspace, then reconcile the original queue. Pending packets are not completion proof.',
      blockedBy:
        failedOfflinePackets.length > 0
          ? 'Failed device-to-server reconciliation'
          : 'Device queue reconciliation',
      source: `${sourcePrefix} · device offline queue`,
      href: '/field',
      entities: pendingOfflinePackets.slice(0, 6).map((packet) => ({
        label: `${packet.kind ?? packet.action} · ${packet.status}`,
        href: '/field',
      })),
    });
  }

  const heldDeliveries = collectHeldDeliveries(state);
  if (heldDeliveries.length > 0) {
    actions.push({
      id: 'transactional-delivery-holds',
      priority: 'P0',
      kind: 'hold',
      title: 'Outbound delivery needs reconciliation',
      fact: `${heldDeliveries.length} quote or on-my-way submission${
        heldDeliveries.length === 1 ? ' has' : 's have'
      } an unknown or failed provider outcome.`,
      recommendation:
        'Read the authoritative provider state. Do not resend while the original submission may have succeeded.',
      blockedBy: 'Provider retrieval or signed callback evidence',
      source: `${sourcePrefix} · transactional delivery projection`,
      href: heldDeliveries[0]!.href,
      entities: heldDeliveries,
    });
  }

  const pastDue = state.invoices.filter((invoice) => invoice.status === 'past_due');
  if (pastDue.length > 0) {
    actions.push({
      id: 'past-due-invoices',
      priority: 'P1',
      kind: 'hold',
      title: 'Review past-due invoices',
      fact: `${pastDue.length} role-visible invoice${pastDue.length === 1 ? ' is' : 's are'} past due: ${pastDue
        .map((invoice) => invoice.number)
        .join(', ')}.`,
      recommendation:
        'Reconcile payment state before an approved reminder; never infer settlement.',
      source: `${sourcePrefix} · invoice status projection`,
      href: '/finance',
      entities: pastDue.map((invoice) => ({ label: invoice.number, href: '/finance' })),
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
      kind: 'hold',
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
      kind: 'follow_up',
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
      kind: 'follow_up',
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
      kind: 'hold',
      title: 'Recurring maintenance is due',
      fact: `${duePlans.length} active maintenance plan${duePlans.length === 1 ? ' is' : 's are'} due for a fresh-estimate work item.`,
      recommendation:
        'Create one idempotent due-work item. Do not reuse the historical price or contact the customer yet.',
      blockedBy: 'Current measurements and a new deterministic estimate',
      source: `${sourcePrefix} · recurring due-work projection`,
      href: '/operations#recurring',
    });
  }
  if (estimateTasks.length > 0) {
    actions.push({
      id: 'recurring-fresh-estimate-queue',
      priority: 'P1',
      kind: 'hold',
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
      kind: 'decision',
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
      kind: 'hold',
      title: 'Resolve provider readiness',
      fact: `${unhealthy.length} integration record${unhealthy.length === 1 ? ' is' : 's are'} not healthy.`,
      recommendation:
        'Check secret-safe health evidence, callback validation, environment switch, and owner switch.',
      blockedBy: 'Provider health or activation evidence',
      source: `${sourcePrefix} · integration health projection`,
      href: '/integrations',
    });
  }

  actions.sort(
    (left, right) => left.priority.localeCompare(right.priority) || left.id.localeCompare(right.id),
  );
  const holds = actions.filter((action) => action.kind === 'hold');
  const decisions = actions.filter((action) => action.kind === 'decision');
  const followUps = actions.filter((action) => action.kind === 'follow_up');
  const nextAction = pickNextOwnerAction(actions);
  const sourcedAt = !live
    ? 'fixed local fixture'
    : freshness === 'untimed'
      ? 'server time unavailable'
      : rawServerTime;
  return {
    mode: live ? 'authenticated' : 'sandbox',
    sourcedAt,
    freshness,
    glance: deriveOwnerCommandGlance({
      freshness,
      sourcedAt,
      holds,
      decisions,
      followUps,
      nextAction,
    }),
    today: {
      localDate,
      timeZone,
      visits: todayVisits,
      evidenceFacts: todayEvidenceFacts,
      status: todayStatus,
      missingExactStarts,
    },
    actions,
    nextAction,
    holds,
    decisions,
    followUps,
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
