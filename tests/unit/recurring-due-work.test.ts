import { describe, expect, it } from 'vitest';
import {
  buildRecurringDueWorkCommand,
  recurringDueWorkReceiptSchema,
  recurringDueWorkStateSchema,
} from '@/core/recurring/dueWork';

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const PLAN_ID = '41000000-0000-4000-8000-000000000001';
const COMMAND_ID = '41000000-0000-4000-8000-000000000101';

describe('recurring due-work contract', () => {
  it('hashes the exact company, plan, version, and due date without price or availability', async () => {
    const command = await buildRecurringDueWorkCommand({
      companyId: COMPANY_ID,
      work: {
        planId: PLAN_ID,
        planVersion: 4,
        dueDate: '2026-07-29',
        commandId: COMMAND_ID,
      },
    });
    expect(command).toEqual({
      commandId: COMMAND_ID,
      requestHash: '0b82fd83f8f3bfe10158caabe3974b6a3504a375778c7e352516397c9b684ba8',
      planId: PLAN_ID,
      planVersion: 4,
      dueDate: '2026-07-29',
    });
    expect(JSON.stringify(command)).not.toMatch(/price|availability|visit|customerContact/u);
  });

  it('accepts only projections that preserve every downstream booking guard', () => {
    const projection = recurringDueWorkStateSchema.parse({
      schemaVersion: 'storyops-recurring-due-work-state-v1',
      companyId: COMPANY_ID,
      role: 'dispatcher',
      localDate: '2026-07-29',
      plans: [
        {
          planId: PLAN_ID,
          planVersion: 4,
          customerId: '10000000-0000-4000-8000-000000000201',
          customerName: 'Morgan Ellis',
          propertyId: '10000000-0000-4000-8000-000000000211',
          propertyName: 'Cedar Ridge',
          cadence: 'semiannual',
          nextDueDate: '2026-07-29',
          serviceCodes: ['gutter-cleaning'],
          requiresFreshEstimate: true,
          dueNow: true,
          generationAction: 'create_fresh_estimate_work_item',
        },
      ],
      workItems: [],
      guardrails: {
        historicalPriceCopied: false,
        estimateCreated: false,
        quoteAccepted: false,
        depositVerified: false,
        availabilityVerified: false,
        visitCreated: false,
        customerContacted: false,
        requiredSequence: [
          'fresh_deterministic_estimate',
          'policy_approval_if_required',
          'quote_acceptance',
          'deposit_verification_if_required',
          'live_scheduling_evidence',
          'job.book',
        ],
      },
      serverTime: '2026-07-29T12:00:00.000Z',
    });

    expect(projection.plans[0]?.generationAction).toBe('create_fresh_estimate_work_item');
    expect(() =>
      recurringDueWorkStateSchema.parse({
        ...projection,
        guardrails: { ...projection.guardrails, availabilityVerified: true },
      }),
    ).toThrow();
  });

  it('rejects a receipt that claims any estimate, quote, deposit, scheduling, visit, or contact', () => {
    const receipt = {
      schemaVersion: 'storyops-recurring-due-work-receipt-v1',
      companyId: COMPANY_ID,
      commandId: COMMAND_ID,
      requestHash: 'a'.repeat(64),
      workItemId: '41000000-0000-4000-8000-000000000201',
      recurringPlanId: PLAN_ID,
      sourcePlanVersion: 4,
      planDueDate: '2026-07-29',
      status: 'fresh_estimate_required',
      freshEstimateRequired: true,
      historicalPriceCopied: false,
      estimateCreated: false,
      quoteAccepted: false,
      depositVerified: false,
      schedulingEvidenceVerified: false,
      visitCreated: false,
      customerContacted: false,
      bookingBoundary: 'job.book',
      alreadyExisted: false,
      replayed: false,
      serverTime: '2026-07-29T12:00:00.000Z',
    };
    expect(recurringDueWorkReceiptSchema.parse(receipt).visitCreated).toBe(false);
    expect(() =>
      recurringDueWorkReceiptSchema.parse({ ...receipt, estimateCreated: true }),
    ).toThrow();
  });
});
