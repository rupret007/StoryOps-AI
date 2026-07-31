import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapLiveWorkspace } from '@/state/liveWorkspaceMapper';
import type { LiveWorkspace } from '@/state/liveRepository';
import { buildStoryOpsCommand } from '@/state/liveRepository';
import { commandMutation, replayOfflineQueue } from '@/state/offlineFieldQueue';
import {
  loadPersistedState,
  purgeClientPersistence,
  savePersistedState,
} from '@/state/persistence';
import { applyCachedRoleScopedVisitSelection } from '@/state/visitSelection';

const companyId = '10000000-0000-4000-8000-000000000001';
const technicianId = '10000000-0000-4000-8000-000000000103';
const customerId = '10000000-0000-4000-8000-000000000201';
const completedPropertyId = '10000000-0000-4000-8000-000000000211';
const firstPropertyId = '10000000-0000-4000-8000-000000000212';
const secondPropertyId = '10000000-0000-4000-8000-000000000213';
const completedJobId = '10000000-0000-4000-8000-000000000631';
const firstJobId = '10000000-0000-4000-8000-000000000632';
const secondJobId = '10000000-0000-4000-8000-000000000633';
const completedVisitId = '10000000-0000-4000-8000-000000000641';
const firstVisitId = '10000000-0000-4000-8000-000000000642';
const secondVisitId = '10000000-0000-4000-8000-000000000643';
const firstChecklistId = '10000000-0000-4000-8000-000000000651';
const secondChecklistId = '10000000-0000-4000-8000-000000000652';
const checklistDefinitionId = '10000000-0000-4000-8000-000000000661';
const checklistTemplateId = '10000000-0000-4000-8000-000000000662';
const materialId = '10000000-0000-4000-8000-000000000671';

function technicianWorkspace(): LiveWorkspace {
  const jobs = [
    {
      id: completedJobId,
      jobNumber: 'JOB-HISTORY',
      customerId,
      propertyId: completedPropertyId,
      status: 'completed',
      serviceCodes: ['gutter-cleaning'],
      estimatedDurationMinutes: 120,
      version: 7,
    },
    {
      id: firstJobId,
      jobNumber: 'JOB-TODAY',
      customerId,
      propertyId: firstPropertyId,
      status: 'scheduled',
      serviceCodes: ['gutter-cleaning'],
      estimatedDurationMinutes: 150,
      version: 3,
    },
    {
      id: secondJobId,
      jobNumber: 'JOB-NEXT',
      customerId,
      propertyId: secondPropertyId,
      status: 'scheduled',
      serviceCodes: ['pressure-wash-flatwork'],
      estimatedDurationMinutes: 180,
      version: 4,
    },
  ];
  const visits = [
    {
      id: completedVisitId,
      jobId: completedJobId,
      status: 'completed',
      startsAt: '2026-07-29T14:00:00.000Z',
      endsAt: '2026-07-29T16:00:00.000Z',
      version: 9,
    },
    {
      id: firstVisitId,
      jobId: firstJobId,
      status: 'confirmed',
      startsAt: '2026-07-30T15:00:00.000Z',
      endsAt: '2026-07-30T17:30:00.000Z',
      version: 5,
    },
    {
      id: secondVisitId,
      jobId: secondJobId,
      status: 'confirmed',
      startsAt: '2026-07-31T14:00:00.000Z',
      endsAt: '2026-07-31T17:00:00.000Z',
      version: 6,
    },
  ];
  const properties = [
    [completedPropertyId, '10 History Lane'],
    [firstPropertyId, '20 Today Lane'],
    [secondPropertyId, '30 Next Lane'],
  ].map(([id, line1]) => ({
    id,
    customerId,
    serviceAddress: { line1, city: 'Dallas', region: 'TX', postalCode: '75201' },
    version: 2,
  }));
  const packet = (
    visitId: string,
    visitVersion: number,
    jobId: string,
    jobNumber: string,
    propertyId: string,
  ) => ({
    visitId,
    visitVersion,
    jobId,
    jobNumber,
    quoteId: '10000000-0000-4000-8000-000000000681',
    propertyId,
    scopeLines: [],
    exclusions: [],
    exclusionsStatus: 'not_recorded',
    access: {
      instructions: null,
      waterSourceNotes: null,
      drainageNotes: null,
      knownHazards: [],
    },
    routeEvidence: null,
    weatherEvidence: null,
    evidence: [],
    changeRequests: [],
  });
  return {
    schemaVersion: 'storyops-workspace-v1',
    serverTime: '2026-07-30T13:00:00.000Z',
    session: { userId: technicianId, companyId, role: 'technician' },
    company: {
      id: companyId,
      name: 'Live Exterior Co',
      timezone: 'America/Chicago',
      currency: 'USD',
      status: 'active',
      settings: {},
      version: 1,
    },
    customers: [{ id: customerId, displayName: 'Assigned Customer', phone: '555-0100' }],
    properties,
    jobs,
    visits,
    checklistItems: [
      {
        id: firstChecklistId,
        visitId: firstVisitId,
        templateItemId: checklistDefinitionId,
        status: 'pending',
        version: 2,
      },
      {
        id: secondChecklistId,
        visitId: secondVisitId,
        templateItemId: checklistDefinitionId,
        status: 'pending',
        version: 3,
      },
    ],
    checklistDefinitions: [
      {
        id: checklistDefinitionId,
        templateId: checklistTemplateId,
        label: 'Confirm exact work area',
        itemKind: 'boolean',
        required: true,
        safetyCritical: false,
        sortOrder: 10,
      },
    ],
    timeEntries: [
      {
        id: '10000000-0000-4000-8000-000000000691',
        visitId: secondVisitId,
        userId: technicianId,
        startedAt: '2026-07-31T14:00:00.000Z',
        endedAt: null,
        breakMinutes: 0,
        source: 'mobile',
        approvedBy: null,
        offlineClientId: null,
        version: 1,
      },
    ],
    materialUsage: [
      {
        id: '10000000-0000-4000-8000-000000000692',
        visitId: secondVisitId,
        materialId,
        quantity: '1.0000',
        unit: 'each',
        recordedAt: '2026-07-31T14:05:00.000Z',
        recordedBy: technicianId,
        offlineClientId: null,
      },
    ],
    media: [
      {
        id: '10000000-0000-4000-8000-000000000693',
        propertyId: secondPropertyId,
        jobId: secondJobId,
        visitId: secondVisitId,
        purpose: 'before',
        objectPath: `${companyId}/visits/${secondVisitId}/before.png`,
        contentType: 'image/png',
        byteSize: 10,
        capturedAt: '2026-07-31T14:03:00.000Z',
        customerVisible: false,
        syncState: 'synced',
        version: 1,
      },
    ],
    materials: [
      {
        id: materialId,
        name: 'Debris bag',
        unit: 'each',
        requiresSds: false,
        version: 1,
      },
    ],
    fieldPackets: [
      packet(completedVisitId, 9, completedJobId, 'JOB-HISTORY', completedPropertyId),
      packet(firstVisitId, 5, firstJobId, 'JOB-TODAY', firstPropertyId),
      {
        ...packet(secondVisitId, 6, secondJobId, 'JOB-NEXT', secondPropertyId),
        evidence: [
          {
            id: '10000000-0000-4000-8000-000000000693',
            purpose: 'before',
            contentType: 'image/png',
            byteSize: 10,
            checksumSha256: 'a'.repeat(64),
            capturedAt: '2026-07-31T14:03:00.000Z',
            syncState: 'synced',
            customerVisible: false,
          },
        ],
      },
    ],
    equipment: [],
  } as unknown as LiveWorkspace;
}

afterEach(async () => {
  await purgeClientPersistence();
});

describe('technician field repeat use', () => {
  it('selects one exact packet across history, reload, durable offline state, and replay', async () => {
    const workspace = technicianWorkspace();
    const initial = mapLiveWorkspace(workspace);
    expect(initial.selectedVisitId).toBe(firstVisitId);
    expect(Object.keys(initial.live?.fieldVisitReferences ?? {}).sort()).toEqual(
      [completedVisitId, firstVisitId, secondVisitId].sort(),
    );

    const cached = applyCachedRoleScopedVisitSelection(
      { ...initial, online: false },
      secondVisitId,
    );
    expect(cached).toMatchObject({
      selectedVisitId: secondVisitId,
      live: {
        fieldPacketVisitId: secondVisitId,
        visit: { id: secondVisitId, version: 6 },
        job: { id: secondJobId, version: 4 },
        jobId: secondJobId,
        customerId,
        propertyId: secondPropertyId,
        activeTimeEntry: { id: '10000000-0000-4000-8000-000000000691', version: 1 },
      },
    });
    expect(Object.keys(cached?.live?.checklistItems ?? {})).toEqual([secondChecklistId]);
    expect(cached?.visits.find((visit) => visit.id === cached.selectedVisitId)).toMatchObject({
      beforePhotos: 1,
      materials: [{ name: 'Debris bag', amount: '1.0000 each' }],
    });

    const selected = mapLiveWorkspace(workspace, { selectedVisitId: secondVisitId });
    expect(selected.selectedVisitId).toBe(secondVisitId);
    expect(selected.live).toMatchObject({
      visit: { id: secondVisitId, version: 6 },
      job: { id: secondJobId, version: 4 },
      jobId: secondJobId,
      propertyId: secondPropertyId,
      activeTimeEntry: { id: '10000000-0000-4000-8000-000000000691', version: 1 },
    });
    expect(Object.keys(selected.live?.checklistItems ?? {})).toEqual([secondChecklistId]);
    expect(selected.visits.find((visit) => visit.id === secondVisitId)).toMatchObject({
      jobNumber: 'JOB-NEXT',
      address: '30 Next Lane, Dallas, TX, 75201',
      beforePhotos: 1,
      materials: [{ name: 'Debris bag', amount: '1.0000 each' }],
    });

    const note = await buildStoryOpsCommand({
      commandId: '10000000-0000-4000-8000-000000000699',
      commandType: 'visit.notes.update',
      expectedVersion: 6,
      payload: { entityId: secondVisitId, notes: 'Exact offline note for the second visit.' },
    });
    const persistedState = {
      ...(cached ?? selected),
      online: false,
      serverVerifiedAt: undefined,
      offlineQueue: [commandMutation(note, '2026-07-30T13:05:00.000Z', [], secondVisitId)],
    };
    expect(await savePersistedState(persistedState)).toBe(true);
    const restored = await loadPersistedState({ userId: technicianId, companyId });
    expect(restored?.selectedVisitId).toBe(secondVisitId);
    expect(restored?.live).toMatchObject({
      fieldPacketVisitId: secondVisitId,
      visit: { id: secondVisitId, version: 6 },
      job: { id: secondJobId, version: 4 },
      jobId: secondJobId,
      customerId,
      propertyId: secondPropertyId,
    });
    expect(Object.keys(restored?.live?.checklistItems ?? {})).toEqual([secondChecklistId]);
    expect(restored?.offlineQueue[0]).toMatchObject({
      scopeVisitId: secondVisitId,
      command: { payload: { entityId: secondVisitId } },
    });

    const refreshed = mapLiveWorkspace(workspace, {
      selectedVisitId: restored?.selectedVisitId,
    });
    expect(refreshed.live?.visit?.id).toBe(secondVisitId);
    const executeCommand = vi.fn(async () => undefined);
    const replay = await replayOfflineQueue(restored?.offlineQueue ?? [], {
      executeCommand,
      uploadMedia: vi.fn(async () => undefined),
    });
    expect(replay).toMatchObject({ confirmed: 1, queue: [] });
    expect(executeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        commandType: 'visit.notes.update',
        payload: expect.objectContaining({ entityId: secondVisitId }),
      }),
    );
  });
});

describe('owner/dispatcher repeat booking queue', () => {
  it('keeps ready jobs selectable while a completed historical field visit is selected', () => {
    const workspace = technicianWorkspace() as unknown as Record<string, unknown>;
    workspace.session = { userId: technicianId, companyId, role: 'owner' };
    workspace.jobs = [
      ...(workspace.jobs as Array<Record<string, unknown>>),
      {
        id: '10000000-0000-4000-8000-000000000634',
        jobNumber: 'JOB-READY-A',
        customerId,
        propertyId: firstPropertyId,
        status: 'ready_to_schedule',
        estimatedDurationMinutes: 90,
        assignedCrewId: '10000000-0000-4000-8000-000000000701',
        version: 2,
      },
      {
        id: '10000000-0000-4000-8000-000000000635',
        jobNumber: 'JOB-READY-B',
        customerId,
        propertyId: secondPropertyId,
        status: 'ready_to_schedule',
        estimatedDurationMinutes: 110,
        version: 3,
      },
    ];

    const first = mapLiveWorkspace(workspace as unknown as LiveWorkspace, {
      selectedVisitId: completedVisitId,
    });
    expect(first.live?.visit?.id).toBe(completedVisitId);
    expect(first.live?.dispatchJob?.id).toBe('10000000-0000-4000-8000-000000000634');
    expect(first.live?.readyToScheduleJobs).toHaveLength(2);

    const explicit = mapLiveWorkspace(workspace as unknown as LiveWorkspace, {
      selectedVisitId: completedVisitId,
      selectedDispatchJobId: '10000000-0000-4000-8000-000000000635',
    });
    expect(explicit.live?.visit?.id).toBe(completedVisitId);
    expect(explicit.live?.dispatchJob).toMatchObject({
      id: '10000000-0000-4000-8000-000000000635',
      version: 3,
      estimatedDurationMinutes: 110,
    });

    workspace.jobs = (workspace.jobs as Array<Record<string, unknown>>).map((job) =>
      job.id === '10000000-0000-4000-8000-000000000635'
        ? { ...job, status: 'scheduled', version: 4 }
        : job,
    );
    const advanced = mapLiveWorkspace(workspace as unknown as LiveWorkspace, {
      selectedVisitId: completedVisitId,
      selectedDispatchJobId: '10000000-0000-4000-8000-000000000635',
    });
    expect(advanced.live?.dispatchJob?.id).toBe('10000000-0000-4000-8000-000000000634');
  });
});
