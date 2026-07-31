import type { DemoState } from '@/state/model';

export type PilotCheckpointStatus = 'complete' | 'current' | 'blocked';

export interface PilotCheckpoint {
  id:
    | 'setup'
    | 'configuration'
    | 'qualification'
    | 'estimate'
    | 'approval'
    | 'quote'
    | 'acceptance'
    | 'booking'
    | 'field'
    | 'invoice'
    | 'follow_up';
  title: string;
  status: PilotCheckpointStatus;
  detail: string;
  href: string;
  actionLabel: string;
}

export interface PilotRehearsal {
  checkpoints: PilotCheckpoint[];
  completeCount: number;
  next: PilotCheckpoint | undefined;
}

type SandboxPilotState = Pick<
  DemoState,
  | 'setupComplete'
  | 'companyConfiguration'
  | 'leads'
  | 'estimate'
  | 'approvals'
  | 'visits'
  | 'invoices'
  | 'customerQuoteAccepted'
  | 'depositPaid'
  | 'reviewRequested'
  | 'referralInvited'
  | 'recurringPlanActive'
>;

type CheckpointInput = Omit<PilotCheckpoint, 'status'> & { complete: boolean };

const checkpoint = (input: CheckpointInput, hasCurrent: boolean): PilotCheckpoint => ({
  ...input,
  status: input.complete ? 'complete' : hasCurrent ? 'blocked' : 'current',
});

/**
 * Projects only the local sandbox golden path. It deliberately derives no
 * provider, weather, routing, payment, or customer-delivery truth.
 */
export function deriveSandboxPilotRehearsal(state: SandboxPilotState): PilotRehearsal {
  const lead = state.leads.find((item) => item.id === state.estimate.leadId);
  const visit = state.visits.find((item) => item.jobNumber === 'JOB-1048');
  const invoice = state.invoices.find((item) => item.jobNumber === 'JOB-1048');
  const leadQualified = Boolean(lead && lead.stage !== 'new');
  const estimateChecked = ['pending_approval', 'approved', 'quoted'].includes(
    state.estimate.status,
  );
  const approvalNeeded = state.estimate.status === 'pending_approval';
  const quoteSent = state.estimate.status === 'quoted';
  const acceptedWithFixture = state.customerQuoteAccepted && state.depositPaid;
  const booked = lead?.stage === 'booked';
  const fieldComplete = booked && visit?.status === 'complete';
  const invoiceIssued = fieldComplete && Boolean(invoice);
  const followUpComplete =
    invoice?.status === 'paid' &&
    state.reviewRequested &&
    state.referralInvited &&
    state.recurringPlanActive;

  const inputs: CheckpointInput[] = [
    {
      id: 'setup',
      title: 'Set up the sandbox workspace',
      complete: state.setupComplete,
      detail: state.setupComplete
        ? 'Local profile and selected-service guardrails are saved on this device.'
        : 'Create a local sandbox profile before exercising fixtures.',
      href: '/setup',
      actionLabel: 'Open setup',
    },
    {
      id: 'configuration',
      title: 'Publish the sandbox company configuration',
      complete:
        state.companyConfiguration?.status === 'published' &&
        state.companyConfiguration.publicationMode === 'sandbox',
      detail:
        state.companyConfiguration?.status === 'published' &&
        state.companyConfiguration.publicationMode === 'sandbox'
          ? `Immutable revision ${state.companyConfiguration.revision} drives the local rehearsal only.`
          : state.companyConfiguration
            ? `Draft revision ${state.companyConfiguration.revision} still needs an explicit sandbox publication receipt.`
            : 'Identity, territory, hours, pricing, people, resources, materials, payments, policies, engagement, and provider controls need a reviewed draft.',
      href: '/setup',
      actionLabel: 'Open company setup',
    },
    {
      id: 'qualification',
      title: 'Qualify Morgan’s supplied facts',
      complete: leadQualified,
      detail: leadQualified
        ? 'The local lead has a qualified stage; no contact or provider action was asserted.'
        : 'Review the seeded intake facts and run the guarded qualification fixture.',
      href: '/pipeline?lead=lead-morgan',
      actionLabel: 'Open lead',
    },
    {
      id: 'estimate',
      title: 'Calculate deterministic estimate',
      complete: estimateChecked,
      detail: estimateChecked
        ? 'The sandbox calculation has a policy outcome and an exact local pricing snapshot.'
        : 'Use the human-verified quantities and published sandbox price-book fixture.',
      href: '/estimates/estimate-1048',
      actionLabel: 'Open estimate',
    },
    {
      id: 'approval',
      title: 'Resolve the policy outcome',
      complete: !approvalNeeded && estimateChecked,
      detail: approvalNeeded
        ? 'This exact estimate payload is held for owner approval.'
        : estimateChecked
          ? 'No unresolved estimate approval is blocking the sandbox quote.'
          : 'A policy outcome is required before this checkpoint can be evaluated.',
      href: approvalNeeded ? '/approvals' : '/estimates/estimate-1048',
      actionLabel: approvalNeeded ? 'Review approval' : 'View policy result',
    },
    {
      id: 'quote',
      title: 'Publish quote portal fixture',
      complete: quoteSent,
      detail: quoteSent
        ? 'The quote is visible in the local portal fixture; email/SMS delivery is not asserted and no customer was contacted.'
        : 'Publish to the portal only after the deterministic estimate is approved or exactly approved.',
      href: '/estimates/estimate-1048',
      actionLabel: 'Open quote',
    },
    {
      id: 'acceptance',
      title: 'Record acceptance and deposit fixture',
      complete: acceptedWithFixture,
      detail: acceptedWithFixture
        ? 'Sandbox acceptance records local terms and deposit fixtures together; no funds moved.'
        : 'Review the customer-facing sandbox quote and record its local acceptance fixture.',
      href: '/portal',
      actionLabel: 'Open portal',
    },
    {
      id: 'booking',
      title: 'Record the sandbox visit',
      complete: booked,
      detail: booked
        ? 'The local Friday visit fixture is recorded; no availability or dispatch provider was reserved.'
        : 'Booking remains a separate dispatcher fixture after acceptance and the deposit fixture.',
      href: '/dispatch',
      actionLabel: 'Open dispatch',
    },
    {
      id: 'field',
      title: 'Complete the field packet',
      complete: fieldComplete,
      detail: fieldComplete
        ? 'Checklist, local evidence counters, materials, notes, and signature fixture are complete.'
        : 'Run the field checklist, evidence, signature, and offline recovery rehearsal.',
      href: '/field',
      actionLabel: 'Open field mode',
    },
    {
      id: 'invoice',
      title: 'Issue the completed-job invoice fixture',
      complete: invoiceIssued,
      detail: invoiceIssued
        ? 'A local invoice fixture exists for the completed Morgan job.'
        : 'Issue an invoice only after the sandbox field completion packet is complete.',
      href: '/finance',
      actionLabel: 'Open finance',
    },
    {
      id: 'follow_up',
      title: 'Exercise post-service fixtures',
      complete: followUpComplete,
      detail: followUpComplete
        ? 'Paid, review, referral, and maintenance states are local fixtures; no outreach was sent.'
        : 'Record the remaining local payment, review, referral, and maintenance fixtures.',
      href: '/finance',
      actionLabel: 'Open follow-up',
    },
  ];

  let hasCurrent = false;
  const checkpoints = inputs.map((input) => {
    const result = checkpoint(input, hasCurrent);
    if (result.status === 'current') hasCurrent = true;
    return result;
  });
  const next = checkpoints.find((item) => item.status === 'current');

  return {
    checkpoints,
    completeCount: checkpoints.filter((item) => item.status === 'complete').length,
    next,
  };
}
