import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoState } from '@/state/demoSeed';
import type { DemoState, StoryOpsActions } from '@/state/model';
import { buildStoryOpsCommand } from '@/state/liveRepository';

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
    if (!mocked.value) throw new Error('Test StoryOps context was not initialized.');
    return mocked.value;
  },
}));

import { FieldPage } from '@/pages/FieldPage';

describe('live field offline completion UI', () => {
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

    expect(screen.getByText('Offline · 1 queued')).toBeVisible();
    expect(screen.getByText(/1 conflict retained/u)).toBeVisible();
    expect(screen.getByText(/durable Storage read-back required on sync/u)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Completion pending sync' })).toBeDisabled();
    expect(screen.queryByText('Completion locked')).not.toBeInTheDocument();
  });
});
