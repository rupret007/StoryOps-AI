import type { DemoState, DemoShowcaseState } from '@/state/model';

type RoleFilteredCheckpointInput = Omit<
  DemoShowcaseState['checkpoints'][number],
  'status' | 'href'
> & {
  complete: boolean;
  roleHref: string;
};

const manifestDate = (): string => new Date().toISOString();

function resolveLead(state: DemoState) {
  return state.leads.find((item) => item.id === state.estimate.leadId);
}

function isSetupReady(state: DemoState): boolean {
  return (
    state.setupComplete &&
    Boolean(
      state.companyConfiguration?.status === 'published' &&
      state.companyConfiguration.publicationMode === 'sandbox',
    )
  );
}

function isLeadQualified(state: DemoState): boolean {
  const lead = resolveLead(state);
  if (!lead) return false;
  return (
    lead.stage !== 'new' &&
    lead.consent &&
    Boolean(lead.phone || lead.email) &&
    lead.address.trim().length > 5 &&
    lead.city.trim().length > 0
  );
}

function isPhotoScopeTrusted(state: DemoState): boolean {
  return state.estimate.photoEvidence.humanVerified;
}

function isDeterministicEstimateReady(state: DemoState): boolean {
  return ['approved', 'quoted', 'pending_approval'].includes(state.estimate.status);
}

function isRouteWeatherReady(state: DemoState): boolean {
  const visit = state.visits.find((item) => item.jobNumber === 'JOB-1048');
  if (!visit) return false;
  return (
    typeof visit.route.driveMinutes === 'number' &&
    typeof visit.route.miles === 'number' &&
    typeof visit.weather.temperature === 'number' &&
    ['watch', 'clear', 'hold'].includes(visit.weather.disposition ?? '')
  );
}

function isVisitBooked(state: DemoState): boolean {
  return resolveLead(state)?.stage === 'booked';
}

function isQuoteAccepted(state: DemoState): boolean {
  return state.estimate.status === 'quoted' && state.customerQuoteAccepted;
}

function isCloseoutReady(state: DemoState): boolean {
  const visit = state.visits.find((item) => item.jobNumber === 'JOB-1048');
  if (!visit) return false;
  const hasPhotos = visit.beforePhotos > 0 && visit.afterPhotos > 0;
  const hasChecklist = visit.checklist.length > 0 && visit.checklist.every((item) => item.complete);
  const invoicePaid = state.invoices.some(
    (invoice) => invoice.jobNumber === 'JOB-1048' && invoice.status === 'paid',
  );
  return (
    visit.status === 'complete' &&
    visit.signature &&
    Boolean(visit.notes.trim()) &&
    hasPhotos &&
    hasChecklist &&
    invoicePaid &&
    state.reviewRequested &&
    state.referralInvited &&
    state.recurringPlanActive
  );
}

function roleAwareHref(
  id: DemoShowcaseState['checkpoints'][number]['id'],
  state: DemoState,
): string {
  if (id === 'quote-and-terms' && !state.customerQuoteAccepted) {
    return '/portal';
  }
  if (id === 'photo-assist') return `/estimates/${state.estimate.id}`;
  if (id === 'lead-qualification') return '/pipeline?lead=lead-morgan';
  if (id === 'dispatch-and-route') return '/dispatch';
  if (id === 'field-closeout') return '/field';
  return '/';
}

export function deriveShowcaseManifest(state: DemoState): DemoShowcaseState {
  const showSetup = isSetupReady(state);
  const leadQualified = isLeadQualified(state);
  const photoTrusted = isPhotoScopeTrusted(state);
  const deterministicEstimate = isDeterministicEstimateReady(state);
  const routeWeatherReady = isRouteWeatherReady(state);
  const visitBooked = isVisitBooked(state);
  const quoteAccepted = isQuoteAccepted(state);
  const closeoutDone = isCloseoutReady(state);

  const checkpointsInput: RoleFilteredCheckpointInput[] = [
    {
      id: 'owner-dashboard',
      title: 'Owner dashboard review',
      role: ['owner'],
      summary: showSetup
        ? 'The owner action queue and visit list are derived from sandbox records; no live profitability or dispatch evidence is shown.'
        : 'Publish sandbox configuration and setup completion before the guided run.',
      detail:
        'Sandbox markers are visible on all cards. This fixture intentionally avoids live provider, payment, and delivery truth.',
      actions: ['Open command center', 'Review owner action queue'],
      roleHref: '/',
      requiresApproval: false,
      evidenceSources: ['setup', 'pricing', 'traces'],
      complete: showSetup,
    },
    {
      id: 'lead-qualification',
      title: 'Lead qualification',
      role: ['owner', 'dispatcher'],
      summary: leadQualified
        ? 'Lead has verified consent, contact, and location facts.'
        : 'Capture exact lead facts and qualify the fixture before pricing.',
      detail:
        'Sources are only local web/chat/SMS/email fixtures and cannot be used for real customer commitments.',
      actions: ['Open lead', 'Run policy qualification'],
      roleHref: '/pipeline?lead=lead-morgan',
      requiresApproval: false,
      evidenceSources: ['lead', 'communication'],
      complete: leadQualified,
    },
    {
      id: 'photo-assist',
      title: 'Photo-assisted scope to deterministic estimate',
      role: ['owner', 'dispatcher', 'technician'],
      summary: photoTrusted
        ? `Confidence ${Math.round(state.estimate.photoEvidence.confidence * 100)}% with ${state.estimate.photoEvidence.unknowns.length} unknown(s).`
        : 'Review unknowns; AI cannot invent measurements or pricing.',
      detail:
        'Human-verified measurements are required before the deterministic quote rule set can be applied.',
      actions: ['Capture evidence', 'Run pricing check'],
      roleHref: `/estimates/${state.estimate.id}`,
      requiresApproval: true,
      evidenceSources: ['photos', 'measurements'],
      complete: photoTrusted && deterministicEstimate,
    },
    {
      id: 'quote-and-terms',
      title: 'Quote, policy approval, and terms',
      role: ['owner', 'customer', 'technician'],
      summary: quoteAccepted
        ? 'Customer terms acknowledgment and acceptance fixture are recorded.'
        : 'Publish fixture quote and capture customer-side terms acceptance.',
      detail:
        'Only sandbox payment and portal behavior are visible; real checkout and SMS/email sending are intentionally blocked.',
      actions: ['Publish quote', 'Review terms'],
      roleHref: '/portal',
      requiresApproval: true,
      evidenceSources: ['estimate', 'quote', 'portal'],
      complete: quoteAccepted,
    },
    {
      id: 'dispatch-and-route',
      title: 'Dispatch and capacity-aware booking',
      role: ['owner', 'dispatcher'],
      summary:
        routeWeatherReady && visitBooked
          ? 'Visit is booked with deterministic route/weather indicators.'
          : 'Capacity/route/weather flags are synthetic until manual dispatch is recorded.',
      detail:
        'Route and weather are shown with evidence freshness tags; live claims are not assumed in this flow.',
      actions: ['Open dispatch', 'Start visit'],
      roleHref: '/dispatch',
      requiresApproval: false,
      evidenceSources: ['dispatch', 'route', 'weather'],
      complete: routeWeatherReady && visitBooked,
    },
    {
      id: 'field-closeout',
      title: 'Field closeout + recurring follow-up',
      role: ['technician', 'owner'],
      summary: closeoutDone
        ? 'Field checklist, media, signature, invoice payment, review, and recurring fixtures are complete.'
        : 'Run mobile field packet, capture proof, sync offline queue, and queue recurring follow-up.',
      detail:
        'No payment state is invented; reconciliation is synthetic and labeled as sandbox-only.',
      actions: ['Finish field packet', 'Sync offline queue'],
      roleHref: '/field',
      requiresApproval: true,
      evidenceSources: ['field', 'offline', 'finance', 'portal'],
      complete: closeoutDone,
    },
  ];

  const uncertainty: string[] = [];
  if (!showSetup) uncertainty.push('Setup is incomplete.');
  if (!leadQualified) uncertainty.push('Lead scope/contact/consent has unresolved values.');
  if (!photoTrusted)
    uncertainty.push('Photo evidence confidence exists but human verification is not complete.');
  if (!deterministicEstimate)
    uncertainty.push('Estimate has not passed deterministic pricing and policy checks.');
  if (!quoteAccepted)
    uncertainty.push('Customer has not accepted terms in a sandbox portal fixture.');
  if (!visitBooked) uncertainty.push('Dispatcher has not booked the job fixture.');
  if (!routeWeatherReady)
    uncertainty.push('Route/weather evidence must be explicitly checked before field release.');
  if (!closeoutDone)
    uncertainty.push('Closeout actions and recurring follow-up fixtures are still pending.');

  let hasCurrent = false;
  const checkpoints = checkpointsInput.map((item) => {
    const { roleHref, ...checkpointWithoutHref } = item;
    const status: DemoShowcaseState['checkpoints'][number]['status'] = item.complete
      ? 'complete'
      : hasCurrent
        ? 'blocked'
        : 'current';
    if (!item.complete && !hasCurrent) hasCurrent = true;
    return {
      ...checkpointWithoutHref,
      status,
      href: roleAwareHref(item.id, state),
    };
  });

  return {
    id: 'showcase-v1.2',
    source: 'deterministic_local_fixture',
    enabled: true,
    badge: 'DEMO',
    route: 'showcase',
    generatedAt: manifestDate(),
    checkpoints,
    completeCount: checkpoints.filter((checkpoint) => checkpoint.status === 'complete').length,
    uncertainty,
    whatIsNext: checkpoints.find((checkpoint) => checkpoint.status === 'current'),
  };
}
