import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoState } from '@/state/demoSeed';
import type { DemoState, StoryOpsActions } from '@/state/model';
import { buildStoryOpsCommand, type PreparedVisitMedia } from '@/state/liveRepository';
import { commandMutation, mediaUploadMutation } from '@/state/offlineFieldQueue';
import type { DispatchGeolocationPosition } from '@/core/scheduling/dispatchOrigin';

const mocked = vi.hoisted(() => ({
  value: undefined as
    | {
        state: DemoState;
        actions: StoryOpsActions;
        can: () => boolean;
      }
    | undefined,
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => {
    if (!mocked.value) throw new Error('Test WashOps context was not initialized.');
    return mocked.value;
  },
}));

import { FieldPage } from '@/pages/FieldPage';

describe('live field offline completion UI', () => {
  it('captures explicit current-location consent before requesting live departure', async () => {
    const base = createDemoState();
    const visit = base.visits[0];
    if (!visit) throw new Error('The field fixture requires a visit.');
    const visitId = '10000000-0000-4000-8000-000000000641';
    const startRouteWithDispatchClearance = vi.fn().mockResolvedValue(true);
    const geolocationDescriptor = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (success: (position: DispatchGeolocationPosition) => void) =>
          success({
            coords: {
              latitude: 32.781,
              longitude: -96.81,
              accuracy: 15,
            },
            timestamp: Date.now() - 1_000,
          }),
      },
    });
    mocked.value = {
      state: {
        ...base,
        dataMode: 'supabase',
        authStatus: 'signed_in',
        role: 'technician',
        online: true,
        serverVerifiedAt: new Date().toISOString(),
        selectedVisitId: visitId,
        visits: [{ ...visit, id: visitId, status: 'ready' }],
        live: {
          userId: '10000000-0000-4000-8000-000000000103',
          companyId: '10000000-0000-4000-8000-000000000001',
          companyName: 'Live Exterior Co',
          companyTimezone: 'America/Chicago',
          serverTime: new Date().toISOString(),
          visit: { id: visitId, version: 7 },
          visitStatus: 'confirmed',
          jobId: '10000000-0000-4000-8000-000000000631',
          propertyId: '10000000-0000-4000-8000-000000000211',
          invoiceVersions: {},
          leadVersions: {},
          checklistItems: {},
          checklistDefinitions: {},
          incidentVersions: {},
          notificationVersions: {},
          approvalVersions: {},
          materials: [],
          customers: [],
          properties: [],
        },
        offlineQueue: [],
      },
      actions: {
        startRouteWithDispatchClearance,
      } as unknown as StoryOpsActions,
      can: () => true,
    };

    try {
      render(<FieldPage />);
      expect(
        screen.getByText(
          /durable receipt keeps accuracy, observation time[\s\S]*but not latitude\/longitude/u,
        ),
      ).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Share location & start' }));
      await waitFor(() => expect(startRouteWithDispatchClearance).toHaveBeenCalledTimes(1));
      expect(startRouteWithDispatchClearance).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'device_geolocation',
          coordinates: { latitude: 32.781, longitude: -96.81 },
          accuracyMeters: 15,
          consent: expect.objectContaining({
            kind: 'explicit_user_action',
            disclosureVersion: 'storyops-dispatch-origin-consent-v1',
          }),
        }),
      );
    } finally {
      if (geolocationDescriptor) {
        Object.defineProperty(navigator, 'geolocation', geolocationDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'geolocation');
      }
    }
  });

  it('does not offer an offline en-route queue or generic route transition', () => {
    const base = createDemoState();
    const visit = base.visits[0];
    if (!visit) throw new Error('The field fixture requires a visit.');
    const visitId = '10000000-0000-4000-8000-000000000641';
    const startRouteWithDispatchClearance = vi.fn();
    mocked.value = {
      state: {
        ...base,
        dataMode: 'supabase',
        authStatus: 'signed_in',
        role: 'technician',
        online: false,
        selectedVisitId: visitId,
        visits: [{ ...visit, id: visitId, status: 'ready' }],
        live: {
          userId: '10000000-0000-4000-8000-000000000103',
          companyId: '10000000-0000-4000-8000-000000000001',
          companyName: 'Live Exterior Co',
          companyTimezone: 'America/Chicago',
          serverTime: '2026-07-28T12:00:00.000Z',
          visit: { id: visitId, version: 7 },
          visitStatus: 'confirmed',
          jobId: '10000000-0000-4000-8000-000000000631',
          propertyId: '10000000-0000-4000-8000-000000000211',
          invoiceVersions: {},
          leadVersions: {},
          checklistItems: {},
          checklistDefinitions: {},
          incidentVersions: {},
          notificationVersions: {},
          approvalVersions: {},
          materials: [],
          customers: [],
          properties: [],
        },
        offlineQueue: [],
      },
      actions: {
        startRouteWithDispatchClearance,
      } as unknown as StoryOpsActions,
      can: () => true,
    };

    render(<FieldPage />);

    expect(screen.getByText(/cannot be queued offline/u)).toBeVisible();
    for (const button of screen.getAllByRole('button', { name: 'Confirmation required' })) {
      expect(button).toBeDisabled();
    }
    expect(startRouteWithDispatchClearance).not.toHaveBeenCalled();
  });

  it('keeps completion visibly pending until the queued dependency packet reconciles', async () => {
    const base = createDemoState();
    const visit = base.visits[0];
    if (!visit) throw new Error('The field fixture requires a visit.');
    const visitId = '10000000-0000-4000-8000-000000000641';
    const completion = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000999',
      commandType: 'visit.transition',
      expectedVersion: 7,
      payload: { entityId: visitId, status: 'completed' },
    });
    const state: DemoState = {
      ...base,
      dataMode: 'supabase',
      authStatus: 'signed_in',
      role: 'technician',
      online: false,
      selectedVisitId: visitId,
      visits: [
        {
          ...visit,
          id: visitId,
          status: 'on_site',
          beforePhotos: 1,
          afterPhotos: 1,
          signature: true,
          materials: [{ name: 'Debris bag', amount: '1 each' }],
          notes: 'Completed the approved scope.',
          route: {},
          weather: {},
          scopeLines: [
            {
              id: '96000000-0000-4000-8000-000000000991',
              lineKind: 'service',
              serviceCode: 'gutter-cleaning',
              description: 'Gutter and downspout cleaning',
              quantity: '180.00',
              unit: 'linear_ft',
              sortOrder: 1,
            },
          ],
          exclusions: [],
          exclusionsStatus: 'not_recorded',
          access: {
            instructions: 'Use the east gate.',
            knownHazards: [],
          },
          checklist: visit.checklist.map((item) => ({ ...item, complete: true })),
        },
      ],
      live: {
        userId: '10000000-0000-4000-8000-000000000103',
        companyId: '10000000-0000-4000-8000-000000000001',
        companyName: 'Live Exterior Co',
        companyTimezone: 'America/Chicago',
        serverTime: '2026-07-28T12:00:00.000Z',
        visit: { id: visitId, version: 7 },
        visitStatus: 'on_site',
        jobId: '10000000-0000-4000-8000-000000000631',
        propertyId: '10000000-0000-4000-8000-000000000211',
        invoiceVersions: {},
        leadVersions: {},
        checklistItems: {},
        checklistDefinitions: {},
        incidentVersions: {},
        notificationVersions: {},
        approvalVersions: {},
        materials: [],
        customers: [],
        properties: [],
      },
      offlineQueue: [
        {
          id: completion.commandId,
          idempotencyKey: completion.commandId,
          action: completion.commandType,
          entityId: visitId,
          scopeVisitId: visitId,
          createdAt: '2026-07-28T12:00:00.000Z',
          status: 'failed',
          kind: 'command',
          dependsOn: [],
          attemptCount: 1,
          lastError: 'Visit version conflict',
          command: completion,
        },
      ],
    };
    mocked.value = {
      state,
      actions: {} as StoryOpsActions,
      can: () => true,
    };

    render(<FieldPage />);

    expect(screen.getByText('Browser offline · 1 queued')).toBeVisible();
    expect(screen.getByText(/1 conflict retained/u)).toBeVisible();
    expect(screen.queryByText('0 min')).not.toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(screen.getByText('Gutter and downspout cleaning')).toBeVisible();
    expect(screen.getByText('Use the east gate.')).toBeVisible();
    expect(screen.getByText(/Not recorded in the accepted estimate snapshot/u)).toBeVisible();
    expect(screen.getByRole('list', { name: 'Field synchronization items' })).toBeVisible();
    expect(screen.getByText('failed')).toBeVisible();
    expect(screen.getByText(/attempt 1/u)).toBeVisible();
    expect(screen.getByText('Visit version conflict')).toBeVisible();
    expect(screen.getByText(/durable Storage read-back required on sync/u)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Completion pending sync' })).toBeDisabled();
    expect(screen.queryByText('Completion locked')).not.toBeInTheDocument();
  });

  it('keeps ordinary work locked after refresh while an atomic incident packet is unsynced', async () => {
    const base = createDemoState();
    const visit = base.visits[0];
    if (!visit) throw new Error('The field fixture requires a visit.');
    const visitId = '10000000-0000-4000-8000-000000000641';
    const incidentStop = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000980',
      commandType: 'incident.report_pause',
      expectedVersion: 7,
      payload: {
        schemaVersion: 'storyops-incident-pause-v1',
        action: 'incident.report_pause',
        actorUserId: '10000000-0000-4000-8000-000000000103',
        entityId: '96000000-0000-4000-8000-000000000981',
        incidentNumber: 'INC-96000000',
        visitId,
        jobId: '10000000-0000-4000-8000-000000000631',
        propertyId: '10000000-0000-4000-8000-000000000211',
        severity: 'minor',
        category: 'other',
        occurredAt: '2026-07-30T12:00:00.000Z',
        requestedAt: '2026-07-30T12:00:01.000Z',
        summary: 'Observed a stop-work incident while the device was offline.',
        immediateActions: 'Stopped work and isolated the affected area.',
        requiresLegalReview: false,
      },
    });
    mocked.value = {
      state: {
        ...base,
        dataMode: 'supabase',
        authStatus: 'signed_in',
        role: 'technician',
        online: true,
        serverVerifiedAt: '2026-07-30T12:05:00.000Z',
        selectedVisitId: visitId,
        visits: [{ ...visit, id: visitId, status: 'on_site' }],
        live: {
          userId: '10000000-0000-4000-8000-000000000103',
          companyId: '10000000-0000-4000-8000-000000000001',
          companyName: 'Live Exterior Co',
          companyTimezone: 'America/Chicago',
          serverTime: '2026-07-30T12:05:00.000Z',
          visit: { id: visitId, version: 7 },
          visitStatus: 'on_site',
          jobId: '10000000-0000-4000-8000-000000000631',
          propertyId: '10000000-0000-4000-8000-000000000211',
          invoiceVersions: {},
          leadVersions: {},
          checklistItems: {},
          checklistDefinitions: {},
          incidentVersions: {},
          notificationVersions: {},
          approvalVersions: {},
          materials: [],
          customers: [],
          properties: [],
        },
        offlineQueue: [
          {
            id: incidentStop.commandId,
            idempotencyKey: incidentStop.commandId,
            action: incidentStop.commandType,
            entityId: incidentStop.payload.entityId as string,
            scopeVisitId: visitId,
            createdAt: '2026-07-30T12:00:01.000Z',
            status: 'queued',
            kind: 'command',
            dependsOn: [],
            attemptCount: 0,
            command: incidentStop,
          },
        ],
      },
      actions: {} as StoryOpsActions,
      can: () => true,
    };

    render(<FieldPage />);

    expect(screen.getByText('Incident stop-work is pending server reconciliation')).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Incident stop-work already active/u }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Complete job' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Sync incident stop-work first/u })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Complete Arrival walkaround/u })).toBeDisabled();
    expect(screen.getByText('Private incident evidence')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Capture private evidence' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add before' })).toBeDisabled();
  });

  it.each([
    {
      label: 'job-only investigating',
      incident: {
        jobId: '10000000-0000-4000-8000-000000000631',
        propertyId: '10000000-0000-4000-8000-000000000211',
      },
    },
    {
      label: 'property-only corrective-action',
      incident: {
        propertyId: '10000000-0000-4000-8000-000000000211',
      },
    },
  ])('keeps $label incident scope locked and private-evidence capable', ({ incident }) => {
    const base = createDemoState();
    const visit = base.visits[0];
    if (!visit) throw new Error('The field fixture requires a visit.');
    const visitId = '10000000-0000-4000-8000-000000000641';
    mocked.value = {
      state: {
        ...base,
        dataMode: 'supabase',
        authStatus: 'signed_in',
        role: 'technician',
        online: true,
        serverVerifiedAt: '2026-07-30T12:05:00.000Z',
        selectedVisitId: visitId,
        visits: [{ ...visit, id: visitId, status: 'paused' }],
        incidents: [
          {
            id: '95000000-0000-4000-8000-000000000521',
            visitId: '',
            ...incident,
            jobNumber: 'JOB-1001',
            kind: 'property_damage',
            summary: 'Progressed unresolved incident still controls this visit.',
            status: 'open',
            reportedAt: '2026-07-30T12:00:00.000Z',
            reportedBy: 'system',
            automationsPaused: true,
          },
        ],
        live: {
          userId: '10000000-0000-4000-8000-000000000103',
          companyId: '10000000-0000-4000-8000-000000000001',
          companyName: 'Live Exterior Co',
          companyTimezone: 'America/Chicago',
          serverTime: '2026-07-30T12:05:00.000Z',
          visit: { id: visitId, version: 10 },
          visitStatus: 'paused',
          jobId: '10000000-0000-4000-8000-000000000631',
          propertyId: '10000000-0000-4000-8000-000000000211',
          invoiceVersions: {},
          leadVersions: {},
          checklistItems: {},
          checklistDefinitions: {},
          incidentVersions: {
            '95000000-0000-4000-8000-000000000521': 2,
          },
          notificationVersions: {},
          approvalVersions: {},
          materials: [],
          customers: [],
          properties: [],
        },
        offlineQueue: [],
      },
      actions: {} as StoryOpsActions,
      can: () => true,
    };

    render(<FieldPage />);

    expect(
      screen.getByText(/Incident 95000000-0000-4000-8000-000000000521 is open/u),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Complete job' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Complete Arrival walkaround/u })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Capture private evidence' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add before' })).toBeDisabled();
  });

  it('allows only queued private incident evidence to recover after stop receipt reconciliation', async () => {
    const base = createDemoState();
    const visit = base.visits[0];
    if (!visit) throw new Error('The field fixture requires a visit.');
    const visitId = '10000000-0000-4000-8000-000000000641';
    const incidentId = '95000000-0000-4000-8000-000000000521';
    const assetId = '96000000-0000-4000-8000-000000000936';
    const checksumSha256 = 'b'.repeat(64);
    const objectPath =
      `10000000-0000-4000-8000-000000000001/incidents/${incidentId}` +
      `/visits/${visitId}/${assetId}-${checksumSha256.slice(0, 16)}-incident.png`;
    const media: PreparedVisitMedia = {
      assetId,
      visitId,
      incidentId,
      purpose: 'incident',
      blob: new Blob(['captured while offline'], { type: 'image/png' }),
      filename: 'incident.png',
      contentType: 'image/png',
      objectPath,
      checksumSha256,
      byteSize: 22,
      capturedAt: '2026-07-30T12:00:02.000Z',
    };
    const upload = mediaUploadMutation(
      '96000000-0000-4000-8000-000000000937',
      media,
      media.capturedAt,
    );
    const register = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000938',
      commandType: 'media.register',
      expectedVersion: 0,
      payload: {
        entityId: assetId,
        incidentId,
        visitId,
        jobId: '10000000-0000-4000-8000-000000000631',
        propertyId: '10000000-0000-4000-8000-000000000211',
        purpose: 'incident',
        objectPath,
        contentType: 'image/png',
        byteSize: media.byteSize,
        checksumSha256,
        capturedAt: media.capturedAt,
        customerVisible: false,
      },
    });
    const ordinary = await buildStoryOpsCommand({
      commandId: '96000000-0000-4000-8000-000000000939',
      commandType: 'visit.notes.update',
      expectedVersion: 10,
      payload: { entityId: visitId, notes: 'Must remain locked until closure.' },
    });
    const syncOfflineQueue = vi.fn().mockResolvedValue(undefined);
    mocked.value = {
      state: {
        ...base,
        dataMode: 'supabase',
        authStatus: 'signed_in',
        role: 'technician',
        online: true,
        serverVerifiedAt: '2026-07-30T12:05:00.000Z',
        selectedVisitId: visitId,
        visits: [{ ...visit, id: visitId, status: 'paused' }],
        incidents: [
          {
            id: incidentId,
            visitId,
            jobId: '10000000-0000-4000-8000-000000000631',
            propertyId: '10000000-0000-4000-8000-000000000211',
            jobNumber: 'JOB-1001',
            kind: 'property_damage',
            summary: 'Authoritative unresolved incident.',
            status: 'open',
            reportedAt: '2026-07-30T12:00:00.000Z',
            reportedBy: 'system',
            automationsPaused: true,
          },
        ],
        live: {
          userId: '10000000-0000-4000-8000-000000000103',
          companyId: '10000000-0000-4000-8000-000000000001',
          companyName: 'Live Exterior Co',
          companyTimezone: 'America/Chicago',
          serverTime: '2026-07-30T12:05:00.000Z',
          visit: { id: visitId, version: 10 },
          visitStatus: 'paused',
          jobId: '10000000-0000-4000-8000-000000000631',
          propertyId: '10000000-0000-4000-8000-000000000211',
          invoiceVersions: {},
          leadVersions: {},
          checklistItems: {},
          checklistDefinitions: {},
          incidentVersions: { [incidentId]: 2 },
          notificationVersions: {},
          approvalVersions: {},
          materials: [],
          customers: [],
          properties: [],
        },
        offlineQueue: [
          commandMutation(ordinary, media.capturedAt, [], visitId),
          upload,
          commandMutation(register, media.capturedAt, [upload.id], visitId),
        ],
      },
      actions: { syncOfflineQueue } as unknown as StoryOpsActions,
      can: () => true,
    };

    render(<FieldPage />);

    const syncButton = screen.getByRole('button', {
      name: 'Sync 2 private evidence changes',
    });
    expect(syncButton).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Complete job' })).toBeDisabled();
    fireEvent.click(syncButton);
    await waitFor(() => expect(syncOfflineQueue).toHaveBeenCalledTimes(1));
  });
});
