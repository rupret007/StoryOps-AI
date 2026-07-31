import { z } from 'zod';
import {
  InMemoryApprovalStore,
  InMemoryIdempotencyStore,
  OfficeOrchestrator,
  OfficeToolRegistry,
  SandboxStructuredModel,
  evaluateSchedulingPrerequisites,
  type ActionProposal,
  type OfficeAgentOutput,
  type OfficeRunRequest,
  type TrustedFact,
} from '@/core/ai';

const companyId = 'company-1';
const jobId = 'job-1';
const nowIso = '2026-07-29T12:00:00.000Z';
const window = {
  start: '2026-07-30T15:00:00.000Z',
  end: '2026-07-30T17:00:00.000Z',
};

function facts(): TrustedFact[] {
  return [
    {
      id: 'capacity-receipt-1',
      name: 'scheduling.capacity_eligibility',
      source: 'database',
      observedAt: '2026-07-29T11:58:00.000Z',
      value: {
        schemaVersion: 'storyops-scheduling-prerequisite-v1',
        receiptId: 'receipt-1',
        kind: 'capacity_availability',
        companyId,
        jobId,
        window,
        checkedAt: '2026-07-29T11:58:00.000Z',
        validUntil: '2026-07-29T12:03:00.000Z',
        evidenceMode: 'live',
        eligibility: 'eligible',
        unknowns: [],
        conflicts: [],
        capacityCheckId: 'capacity-check-1',
        provider: 'google_calendar',
        capacityDisposition: 'eligible',
        freeBusyDisposition: 'eligible',
        availableCrewId: 'crew-1',
        sourceCalendarIds: ['primary'],
      },
    },
    {
      id: 'weather-receipt-1',
      name: 'scheduling.weather_eligibility',
      source: 'deterministic_calculation',
      observedAt: '2026-07-29T11:30:00.000Z',
      value: {
        schemaVersion: 'storyops-scheduling-prerequisite-v1',
        receiptId: 'receipt-1',
        kind: 'weather_policy',
        companyId,
        jobId,
        window,
        checkedAt: '2026-07-29T11:30:00.000Z',
        validUntil: '2026-07-29T12:30:00.000Z',
        evidenceMode: 'live',
        eligibility: 'eligible',
        unknowns: [],
        conflicts: [],
        weatherCheckId: 'weather-check-1',
        provider: 'nws',
        forecastIssuedAt: '2026-07-29T10:00:00.000Z',
        policyVersion: 'dfw-weather-v1',
        policyDisposition: 'eligible',
      },
    },
    {
      id: 'route-receipt-1',
      name: 'scheduling.route_eligibility',
      source: 'provider',
      observedAt: '2026-07-29T11:45:00.000Z',
      value: {
        schemaVersion: 'storyops-scheduling-prerequisite-v1',
        receiptId: 'receipt-1',
        kind: 'route',
        companyId,
        jobId,
        window,
        checkedAt: '2026-07-29T11:45:00.000Z',
        validUntil: '2026-07-29T12:15:00.000Z',
        evidenceMode: 'live',
        eligibility: 'eligible',
        unknowns: [],
        conflicts: [],
        routeCheckId: 'route-check-1',
        provider: 'vroom',
        routeDisposition: 'eligible',
        routeFeasible: true,
        violations: [],
      },
    },
  ];
}

function consumedBookingFact(): TrustedFact {
  return {
    id: 'booking-confirmation-receipt-1',
    name: 'scheduling.booking_confirmation',
    source: 'database',
    observedAt: '2026-07-29T11:59:00.000Z',
    value: {
      schemaVersion: 'storyops-booking-confirmation-v1',
      receiptId: 'receipt-1',
      companyId,
      jobId,
      visitId: 'visit-1',
      window,
      crewId: 'crew-1',
      evidenceMode: 'live',
      consumedAt: '2026-07-29T11:59:00.000Z',
      jobStatus: 'scheduled',
      visitStatus: 'planned',
    },
  };
}

function bookingProposal(sourceFacts = facts()): ActionProposal {
  return {
    actionId: 'booking-1',
    toolName: 'calendar.create_booking',
    purpose: 'Create the exact evidence-backed booking.',
    payload: {
      title: 'Exterior cleaning',
      window,
      timeZone: 'America/Chicago',
      jobId,
    },
    risk: 'low',
    reversible: false,
    sourceFactIds: sourceFacts.map((fact) => fact.id),
  };
}

function request(trustedFacts = facts()): OfficeRunRequest {
  return {
    runId: 'run-1',
    companyId,
    agent: 'scheduling',
    objective: 'Book one verified job window.',
    actor: { id: 'owner-1', role: 'owner' },
    trustedFacts,
    untrustedContent: [],
    idempotencyKey: 'scheduling-run-key',
    requestedAt: nowIso,
  };
}

function output(proposal: ActionProposal): OfficeAgentOutput {
  return {
    summary: 'Prepared one evidence-backed scheduling action.',
    confidence: 1,
    evidence: [
      {
        claim: 'Capacity is eligible for the exact window.',
        sourceFactIds: [proposal.sourceFactIds[0] ?? 'missing'],
        confidence: 1,
      },
    ],
    unknowns: [],
    proposedActions: [proposal],
    customerDraft: null,
    ownerAttention: false,
  };
}

function bookingRegistry(execute = vi.fn(async () => ({ status: 'confirmed' }))) {
  return {
    execute,
    registry: new OfficeToolRegistry().register({
      name: 'calendar.create_booking',
      description: 'Test-only confirmed booking provider.',
      input: z.object({
        title: z.string(),
        window: z.object({ start: z.string(), end: z.string() }),
        timeZone: z.string(),
        jobId: z.string(),
      }),
      risk: 'low',
      sideEffect: 'external_write',
      reversible: false,
      supportsIdempotency: true,
      autoExecute: false,
      execute,
    }),
  };
}

describe('AI scheduling prerequisite boundary', () => {
  it('accepts only a complete, company-owned, exact-window live evidence set', () => {
    const trustedFacts = facts();
    const decision = evaluateSchedulingPrerequisites({
      request: request(trustedFacts),
      proposal: bookingProposal(trustedFacts),
      now: new Date(nowIso),
    });

    expect(decision).toMatchObject({
      required: true,
      eligible: true,
      evidenceMode: 'live',
      target: { jobId, window },
    });
  });

  it.each([
    {
      title: 'missing route receipt',
      mutate: (trustedFacts: TrustedFact[]) => trustedFacts.slice(0, 2),
      reason: 'exactly one route eligibility',
    },
    {
      title: 'stale capacity receipt',
      mutate: (trustedFacts: TrustedFact[]) => {
        trustedFacts[0] = {
          ...trustedFacts[0]!,
          observedAt: '2026-07-29T11:50:00.000Z',
          value: {
            ...(trustedFacts[0]!.value as Record<string, unknown>),
            checkedAt: '2026-07-29T11:50:00.000Z',
            validUntil: '2026-07-29T12:05:00.000Z',
          },
        };
        return trustedFacts;
      },
      reason: 'stale',
    },
    {
      title: 'cross-company weather receipt',
      mutate: (trustedFacts: TrustedFact[]) => {
        trustedFacts[1] = {
          ...trustedFacts[1]!,
          value: {
            ...(trustedFacts[1]!.value as Record<string, unknown>),
            companyId: 'company-2',
          },
        };
        return trustedFacts;
      },
      reason: 'not owned',
    },
    {
      title: 'unknown weather disposition',
      mutate: (trustedFacts: TrustedFact[]) => {
        trustedFacts[1] = {
          ...trustedFacts[1]!,
          value: {
            ...(trustedFacts[1]!.value as Record<string, unknown>),
            eligibility: 'unknown',
            policyDisposition: 'unknown',
          },
        };
        return trustedFacts;
      },
      reason: 'not explicitly eligible',
    },
  ])('fails closed on $title', ({ mutate, reason }) => {
    const trustedFacts = mutate(facts());
    const decision = evaluateSchedulingPrerequisites({
      request: request(trustedFacts),
      proposal: bookingProposal(trustedFacts),
      now: new Date(nowIso),
    });

    expect(decision).toMatchObject({ required: true, eligible: false });
    if (decision.required && !decision.eligible) {
      expect(decision.reason.toLowerCase()).toContain(reason);
    }
  });

  it('rejects a fresh conflicting receipt even when the model cites the eligible one', () => {
    const trustedFacts = facts();
    const route = trustedFacts[2]!;
    trustedFacts.push({
      ...structuredClone(route),
      id: 'route-receipt-conflict',
      observedAt: '2026-07-29T11:50:00.000Z',
      value: {
        ...(route.value as Record<string, unknown>),
        checkedAt: '2026-07-29T11:50:00.000Z',
        validUntil: '2026-07-29T12:20:00.000Z',
        eligibility: 'ineligible',
        routeDisposition: 'ineligible',
        routeFeasible: false,
      },
    });
    const proposal = bookingProposal(trustedFacts.slice(0, 3));
    const decision = evaluateSchedulingPrerequisites({
      request: request(trustedFacts),
      proposal,
      now: new Date(nowIso),
    });

    expect(decision).toMatchObject({ required: true, eligible: false });
    if (decision.required && !decision.eligible) {
      expect(decision.reason).toContain('conflicting');
    }
  });

  it('rejects otherwise eligible components mixed across persisted receipts', () => {
    const trustedFacts = facts();
    trustedFacts[1] = {
      ...trustedFacts[1]!,
      value: {
        ...(trustedFacts[1]!.value as Record<string, unknown>),
        receiptId: 'receipt-2',
      },
    };
    const decision = evaluateSchedulingPrerequisites({
      request: request(trustedFacts),
      proposal: bookingProposal(trustedFacts),
      now: new Date(nowIso),
    });

    expect(decision).toMatchObject({ required: true, eligible: false });
    if (decision.required && !decision.eligible) {
      expect(decision.reason).toContain('one exact persisted receipt');
    }
  });

  it('denies AI booking because the deterministic reconciliation worker is the only writer', async () => {
    const trustedFacts = facts().slice(0, 2);
    const proposal = bookingProposal(trustedFacts);
    const approvals = new InMemoryApprovalStore();
    const { registry, execute } = bookingRegistry();
    const orchestrator = new OfficeOrchestrator({
      model: new SandboxStructuredModel(() => output(proposal)),
      tools: registry,
      approvals,
      idempotency: new InMemoryIdempotencyStore(),
      now: () => new Date(nowIso),
    });

    const result = await orchestrator.run(request(trustedFacts));

    expect(result.actions[0]).toMatchObject({
      status: 'denied',
      policyRule: 'AI-001-least-privilege',
    });
    expect(approvals.list()).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not create a dead-end approval even for a complete booking receipt set', async () => {
    const trustedFacts = facts();
    const proposal = bookingProposal(trustedFacts);
    const approvals = new InMemoryApprovalStore();
    const { registry, execute } = bookingRegistry();
    const orchestrator = new OfficeOrchestrator({
      model: new SandboxStructuredModel(() => output(proposal)),
      tools: registry,
      approvals,
      idempotency: new InMemoryIdempotencyStore(),
      now: () => new Date(nowIso),
    });
    const result = await orchestrator.run(request(trustedFacts));

    expect(result.actions[0]).toMatchObject({
      status: 'denied',
      policyRule: 'AI-001-least-privilege',
    });
    expect(approvals.list()).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires a consumed receipt and exact local schedule before confirming to a customer', () => {
    const trustedFacts = facts();
    const message: ActionProposal = {
      actionId: 'confirmation-1',
      toolName: 'communications.send_email',
      purpose: 'Confirm a customer appointment.',
      payload: {
        to: ['customer@example.test'],
        subject: 'Appointment confirmed',
        text: 'Your appointment is confirmed.',
        category: 'transactional',
        consentSnapshotIds: { 'customer@example.test': 'consent-1' },
      },
      risk: 'medium',
      reversible: false,
      sourceFactIds: trustedFacts.map((fact) => fact.id),
    };

    expect(
      evaluateSchedulingPrerequisites({
        request: request(trustedFacts),
        proposal: message,
        now: new Date(nowIso),
      }),
    ).toMatchObject({ required: true, eligible: false });

    message.payload.schedulingContext = {
      intent: 'booking_confirmation',
      jobId,
      window,
    };
    expect(
      evaluateSchedulingPrerequisites({
        request: { ...request(trustedFacts), agent: 'follow_up' },
        proposal: message,
        now: new Date(nowIso),
      }),
    ).toMatchObject({ required: true, eligible: false });

    const confirmedFacts = [...trustedFacts, consumedBookingFact()];
    message.sourceFactIds = confirmedFacts.map((fact) => fact.id);
    expect(
      evaluateSchedulingPrerequisites({
        request: { ...request(confirmedFacts), agent: 'follow_up' },
        proposal: message,
        now: new Date(nowIso),
      }),
    ).toMatchObject({ required: true, eligible: true });
  });
});
