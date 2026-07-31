import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from '@/router';
import { createDemoState } from '@/state/demoSeed';
import type { DemoState, StoryOpsActions } from '@/state/model';

const payloadHash = 'a'.repeat(64);
const estimateId = '96500000-0000-4000-8000-000000000501';

const mocked = vi.hoisted(() => ({
  state: undefined as DemoState | undefined,
  decideApproval: vi.fn(),
}));

vi.mock('@/state/StoryOpsProvider', () => ({
  useStoryOps: () => {
    if (!mocked.state) throw new Error('Approval test state was not initialized.');
    return {
      state: mocked.state,
      actions: {
        decideApproval: mocked.decideApproval,
      } as unknown as StoryOpsActions,
      can: () => true,
    };
  },
}));

import { ApprovalsPage } from '@/pages/ApprovalsPage';

describe('exact estimate approval presentation', () => {
  beforeEach(() => {
    mocked.decideApproval.mockReset();
    const state = createDemoState();
    state.approvals = [
      {
        id: '96500000-0000-4000-8000-000000000801',
        reason: 'large_discount',
        title: 'estimate.approve_exception',
        summary: '4 blocking estimate exceptions require owner review of the exact payload.',
        risk: 'high',
        status: 'pending',
        requestedAt: 'Jul 30, 8:00 PM',
        expiresAt: 'Jul 31, 8:00 PM',
        entityId: estimateId,
        payloadPreview: JSON.stringify(
          {
            schemaVersion: 'storyops-estimate-exception-exact-v1',
            operation: 'estimate.approve_exception',
            estimateId,
            snapshot: {
              total: '528.00',
              discount: '102.69',
              marginPercent: '12.3400',
            },
            blockingFlags: [
              'large_discount',
              'margin_below_floor',
              'price_exception',
              'uncertain_scope',
            ],
          },
          null,
          2,
        ),
        payloadHash,
        blockingFlags: [
          {
            reason: 'large_discount',
            riskLevel: 'high',
            summary: 'The discount exceeds the automatic limit.',
          },
          {
            reason: 'margin_below_floor',
            riskLevel: 'high',
            summary: 'The deterministic margin is below the published floor.',
          },
          {
            reason: 'price_exception',
            riskLevel: 'high',
            summary: 'A manual price adjustment is outside automatic policy.',
          },
          {
            reason: 'uncertain_scope',
            riskLevel: 'high',
            summary: 'Scope evidence still contains owner-review unknowns.',
          },
        ],
        policyVersion: 'storyops-policy-v1.0.0',
        actionType: 'estimate.approve_exception',
      },
    ];
    mocked.state = state;
  });

  it('shows every blocker, the actual exact payload, and its hash before approval', () => {
    render(
      <MemoryRouter>
        <ApprovalsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('high risk')).toBeVisible();
    const blockers = screen.getByRole('region', {
      name: 'Blocking reasons for estimate.approve_exception',
    });
    for (const reason of [
      'large_discount',
      'margin_below_floor',
      'price_exception',
      'uncertain_scope',
    ]) {
      expect(within(blockers).getByText(reason)).toBeVisible();
    }
    expect(blockers).toHaveTextContent('The discount exceeds the automatic limit.');
    expect(blockers).toHaveTextContent('below the published floor');
    expect(blockers).toHaveTextContent('manual price adjustment');
    expect(blockers).toHaveTextContent('owner-review unknowns');

    expect(screen.getByText(payloadHash)).toBeVisible();
    expect(screen.getByText(/"estimateId": "96500000-0000-4000-8000-000000000501"/u)).toBeVisible();
    expect(screen.getByText(/"discount": "102.69"/u)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Approve exact payload' }));
    expect(mocked.decideApproval).toHaveBeenCalledWith(
      '96500000-0000-4000-8000-000000000801',
      'approved',
    );
  });
});
