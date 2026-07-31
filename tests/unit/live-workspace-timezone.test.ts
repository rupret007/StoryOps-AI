import { describe, expect, it } from 'vitest';
import { mapLiveWorkspace } from '@/state/liveWorkspaceMapper';

const companyId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const customerId = '33333333-3333-4333-8333-333333333333';
const propertyId = '44444444-4444-4444-8444-444444444444';
const jobId = '55555555-5555-4555-8555-555555555555';
const visitId = '66666666-6666-4666-8666-666666666666';

describe('live workspace visit timezone projection', () => {
  it('renders visit dates and times in the authoritative company timezone', () => {
    const state = mapLiveWorkspace({
      schemaVersion: 'storyops-workspace-v1',
      serverTime: '2026-07-30T02:00:00.000Z',
      session: { userId, companyId, role: 'owner' },
      company: {
        id: companyId,
        name: 'Pacific Exterior Services',
        timezone: 'America/Los_Angeles',
        currency: 'USD',
        status: 'active',
        settings: {},
        version: 1,
      },
      customers: [{ id: customerId, displayName: 'Taylor Customer' }],
      properties: [
        {
          id: propertyId,
          customerId,
          serviceAddress: {
            line1: '100 Main Street',
            city: 'Los Angeles',
            region: 'CA',
            postalCode: '90001',
            country: 'US',
          },
        },
      ],
      jobs: [
        {
          id: jobId,
          customerId,
          propertyId,
          jobNumber: 'JOB-TZ-001',
          status: 'scheduled',
          version: 1,
        },
      ],
      visits: [
        {
          id: visitId,
          jobId,
          startsAt: '2026-07-30T02:00:00.000Z',
          endsAt: '2026-07-30T03:00:00.000Z',
          status: 'planned',
          version: 1,
        },
      ],
    });

    expect(state.visits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: visitId,
          date: '2026-07-29',
          startsAt: '7:00 PM',
          endsAt: '8:00 PM',
        }),
      ]),
    );
  });
});
