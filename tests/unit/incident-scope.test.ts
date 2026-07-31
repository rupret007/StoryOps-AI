import { describe, expect, it } from 'vitest';
import { incidentAffectsVisit, unresolvedIncidentForVisit } from '@/state/incidentScope';
import { mapLiveWorkspace } from '@/state/liveWorkspaceMapper';

const companyId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000103';
const propertyId = '10000000-0000-4000-8000-000000000211';
const otherPropertyId = '10000000-0000-4000-8000-000000000212';
const jobId = '10000000-0000-4000-8000-000000000631';
const otherJobId = '10000000-0000-4000-8000-000000000632';
const visitId = '10000000-0000-4000-8000-000000000641';

function mappedIncidents() {
  return mapLiveWorkspace({
    schemaVersion: 'storyops-workspace-v1',
    serverTime: '2026-07-30T12:00:00.000Z',
    session: { userId, companyId, role: 'technician' },
    company: {
      id: companyId,
      name: 'Scoped Incident Co',
      timezone: 'America/Chicago',
      currency: 'USD',
      status: 'active',
      settings: {},
      version: 1,
    },
    jobs: [
      { id: jobId, jobNumber: 'JOB-1001', propertyId, version: 2 },
      { id: otherJobId, jobNumber: 'JOB-1002', propertyId, version: 2 },
    ],
    fieldIncidents: [
      {
        id: '95000000-0000-4000-8000-000000000521',
        visitId: null,
        jobId,
        propertyId,
        category: 'property_damage',
        summary: 'Job-wide investigation remains unresolved.',
        status: 'investigating',
        reportedAt: '2026-07-30T11:55:00.000Z',
        version: 2,
      },
      {
        id: '95000000-0000-4000-8000-000000000522',
        visitId: null,
        jobId: null,
        propertyId,
        category: 'other',
        summary: 'Property-wide corrective action remains unresolved.',
        status: 'corrective_action',
        reportedAt: '2026-07-30T11:56:00.000Z',
        version: 3,
      },
    ],
  }).incidents;
}

describe('incident visit scope', () => {
  it('preserves job/property scope and normalizes progressed unresolved statuses', () => {
    const incidents = mappedIncidents();

    expect(incidents).toEqual([
      expect.objectContaining({
        id: '95000000-0000-4000-8000-000000000521',
        visitId: '',
        jobId,
        propertyId,
        jobNumber: 'JOB-1001',
        status: 'open',
      }),
      expect.objectContaining({
        id: '95000000-0000-4000-8000-000000000522',
        visitId: '',
        jobId: undefined,
        propertyId,
        status: 'open',
      }),
    ]);
  });

  it('matches the server visit OR job OR property-only stop-work rule exactly', () => {
    const [jobIncident, propertyIncident] = mappedIncidents();
    expect(jobIncident).toBeDefined();
    expect(propertyIncident).toBeDefined();

    expect(incidentAffectsVisit(jobIncident!, { visitId, jobId, propertyId })).toBe(true);
    expect(
      incidentAffectsVisit(jobIncident!, {
        visitId,
        jobId: otherJobId,
        propertyId,
      }),
    ).toBe(false);
    expect(
      incidentAffectsVisit(propertyIncident!, {
        visitId,
        jobId: otherJobId,
        propertyId,
      }),
    ).toBe(true);
    expect(
      unresolvedIncidentForVisit([propertyIncident!], {
        visitId,
        jobId: otherJobId,
        propertyId: otherPropertyId,
      }),
    ).toBeUndefined();
  });
});
