import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDemoState } from '@/state/demoSeed';
import type { DemoState, StoryOpsActions } from '@/state/model';
import type { SchedulingSuggestionsResponse } from '@/core/scheduling/suggestions';

const mocked = vi.hoisted(() => ({
  state: undefined as DemoState | undefined,
  actions: undefined as StoryOpsActions | undefined,
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => {
    if (!mocked.state || !mocked.actions) throw new Error('Dispatch test context is missing.');
    return {
      state: mocked.state,
      actions: mocked.actions,
      can: () => true,
    };
  },
}));

import { DispatchPage } from '@/pages/DispatchPage';

const companyId = '10000000-0000-4000-8000-000000000001';
const jobId = '10000000-0000-4000-8000-000000000631';
const crewId = '10000000-0000-4000-8000-000000000601';

function suggestionResult(): SchedulingSuggestionsResponse {
  return {
    schemaVersion: 'storyops-scheduling-suggestions-v1',
    operation: 'scheduling.suggestions',
    status: 'suggestions_ready',
    bookable: false,
    companyId,
    jobId,
    jobVersion: 4,
    generatedAt: '2026-07-30T12:00:00.000Z',
    timeZone: 'America/Chicago',
    durationMinutes: 120,
    scannedWindowCount: 12,
    candidates: [
      {
        rank: 1,
        window: {
          start: '2026-08-03T13:00:00.000Z',
          end: '2026-08-03T15:00:00.000Z',
        },
        localStart: '2026-08-03T08:00',
        crewId,
        crewName: 'Owner crew',
        eligibleCrewCount: 1,
        appointmentBufferMinutes: 30,
        requiredSkills: ['exterior-cleaning'],
        requiredEquipment: ['pressure-washer'],
        internalEvidence: {
          businessHours: 'eligible',
          leadTime: 'eligible',
          crew: 'eligible',
          equipment: 'eligible',
          visitCapacity: 'eligible',
        },
        liveValidation: {
          providerCalendar: 'unknown',
          route: 'unknown',
          weather: 'unknown',
        },
        reasons: [
          'One current crew satisfies internal capacity facts.',
          'Live providers remain unknown.',
        ],
      },
    ],
    unknowns: [
      'Google Calendar free/busy is unknown until the operator verifies this exact window.',
      'Route feasibility and travel time are unknown until VROOM validates this exact crew-day route.',
      'Service-window weather is unknown until fresh NWS evidence is evaluated against policy.',
    ],
    message: 'One candidate is ready for review.',
  };
}

describe('live dispatch scheduling suggestions', () => {
  it('shows ranked candidates and keeps verification separate from explicit booking', async () => {
    const state = createDemoState();
    state.dataMode = 'supabase';
    state.authStatus = 'signed_in';
    state.role = 'owner';
    state.online = true;
    state.selectedDispatchJobId = jobId;
    state.live = {
      userId: '10000000-0000-4000-8000-000000000101',
      companyId,
      companyName: 'Pilot Exterior Care',
      companyTimezone: 'America/Chicago',
      serverTime: '2026-07-30T12:00:00.000Z',
      readyToScheduleJobs: [
        {
          id: jobId,
          version: 4,
          jobNumber: 'JOB-1048',
          customerName: 'Morgan Ellis',
          propertyAddress: '1842 Cedar Ridge Lane',
          estimatedDurationMinutes: 120,
          assignedCrewId: crewId,
        },
      ],
      dispatchJob: {
        id: jobId,
        version: 4,
        jobNumber: 'JOB-1048',
        customerName: 'Morgan Ellis',
        propertyAddress: '1842 Cedar Ridge Lane',
        estimatedDurationMinutes: 120,
        assignedCrewId: crewId,
      },
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
    };
    const loadSchedulingSuggestions = vi.fn().mockResolvedValue(suggestionResult());
    const refreshSchedulingEvidence = vi.fn().mockResolvedValue({
      mode: 'live',
      status: 'ready_to_book',
      bookable: true,
      reasonCode: 'LIVE_EVIDENCE_READY',
      message: 'Exact live evidence is ready.',
      companyId,
      jobId,
      jobVersion: 4,
      window: {
        start: '2026-08-03T13:00:00.000Z',
        end: '2026-08-03T15:00:00.000Z',
      },
      crewId,
      receipt: {
        receiptId: '10000000-0000-4000-8000-000000000705',
        crewId,
        startsAt: '2026-08-03T13:00:00.000Z',
        endsAt: '2026-08-03T15:00:00.000Z',
        calendarEventId: 'calendar-event-1',
        expiresAt: '2026-08-03T12:15:00.000Z',
        evidenceHash: 'a'.repeat(64),
        replayed: false,
      },
    });
    const bookJob = vi.fn();
    mocked.state = state;
    mocked.actions = {
      loadSchedulingSuggestions,
      refreshSchedulingEvidence,
      bookJob,
      reloadLiveWorkspace: vi.fn(),
      selectDispatchJob: vi.fn(),
    } as unknown as StoryOpsActions;

    render(<DispatchPage />);

    expect(await screen.findByRole('list', { name: 'Ranked scheduling candidates' })).toBeVisible();
    expect(screen.getByText(/Calendar, route, weather: unknown/u)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Verify & reserve exact window' }));

    await waitFor(() => expect(refreshSchedulingEvidence).toHaveBeenCalledTimes(1));
    expect(refreshSchedulingEvidence).toHaveBeenCalledWith({
      startsAt: '2026-08-03T13:00:00.000Z',
      endsAt: '2026-08-03T15:00:00.000Z',
      crewId,
    });
    expect(await screen.findByText(/job is not booked until you finalize it/u)).toBeVisible();
    expect(bookJob).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Finalize reserved window' })).toBeEnabled();
  });
});
