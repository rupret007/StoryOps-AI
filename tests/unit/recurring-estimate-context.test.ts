import { describe, expect, it } from 'vitest';
import { resolveLiveEstimateIdentity } from '@/pages/EstimatePage';
import type { RecurringDueWorkItem } from '@/core/recurring/dueWork';

const workItem: RecurringDueWorkItem = {
  id: '41000000-0000-4000-8000-000000000201',
  recurringPlanId: '41000000-0000-4000-8000-000000000001',
  planDueDate: '2026-07-29',
  customerId: '10000000-0000-4000-8000-000000000201',
  customerName: 'Morgan Ellis',
  propertyId: '10000000-0000-4000-8000-000000000211',
  propertyName: 'Cedar Ridge',
  serviceCodes: ['gutter-cleaning'],
  sourcePlanVersion: 4,
  status: 'fresh_estimate_required',
  estimateId: null,
  estimateLinkedAt: null,
  createdAt: '2026-07-29T12:00:00.000Z',
  version: 1,
  freshEstimateRequired: true,
  historicalPriceCopied: false,
  estimateCreated: false,
  quoteAccepted: false,
  depositVerified: false,
  schedulingEvidenceVerified: false,
  visitCreated: false,
  customerContacted: false,
  bookingBoundary: 'job.book',
  nextAction: 'Capture current measurements and create a new deterministic estimate.',
};

describe('recurring estimate route context', () => {
  it('uses the exact projected work-item customer/property without inventing a lead', () => {
    expect(
      resolveLiveEstimateIdentity({
        requestedRecurringWorkItemId: workItem.id,
        recurringWorkItems: [workItem],
        requestedLeadId: 'lead-that-must-not-be-used',
        leads: [
          {
            id: 'lead-that-must-not-be-used',
            customerId: '20000000-0000-4000-8000-000000000201',
            propertyId: '20000000-0000-4000-8000-000000000211',
          },
        ],
      }),
    ).toMatchObject({
      recurringWorkItem: workItem,
      customerId: workItem.customerId,
      propertyId: workItem.propertyId,
    });
    expect(
      resolveLiveEstimateIdentity({
        requestedRecurringWorkItemId: workItem.id,
        recurringWorkItems: [workItem],
        requestedLeadId: 'lead-that-must-not-be-used',
        leads: [],
      }),
    ).not.toHaveProperty('leadId');
  });

  it('fails closed for an unprojected recurring work-item ID', () => {
    expect(
      resolveLiveEstimateIdentity({
        requestedRecurringWorkItemId: '41000000-0000-4000-8000-000000000999',
        recurringWorkItems: [workItem],
        requestedLeadId: '',
        leads: [],
      }),
    ).toEqual({});
  });
});
