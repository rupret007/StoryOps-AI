import { describe, expect, it } from 'vitest';
import { mapLiveWorkspace } from '@/state/liveWorkspaceMapper';

const companyId = '10000000-0000-4000-8000-000000000001';
const ownerId = '10000000-0000-4000-8000-000000000101';
const estimateId = '96500000-0000-4000-8000-000000000501';
const approvalId = '96500000-0000-4000-8000-000000000801';
const payloadHash = 'f'.repeat(64);

describe('live exact approval projection', () => {
  it('preserves the exact payload, deterministic hash, all blockers, and actual risk', () => {
    const exactPayload = {
      schemaVersion: 'storyops-estimate-exception-exact-v1',
      operation: 'estimate.approve_exception',
      companyId,
      estimateId,
      quoteId: '96500000-0000-4000-8000-000000000521',
      intentHash: 'a'.repeat(64),
      authoritativeSnapshotHash: 'b'.repeat(64),
      snapshot: {
        total: '528.00',
        discount: '102.69',
        marginPercent: '12.3400',
      },
      blockingFlags: [
        {
          reason: 'large_discount',
          riskLevel: 'high',
          summary: 'The discount exceeds the automatic limit.',
          blocking: true,
        },
        {
          reason: 'margin_below_floor',
          riskLevel: 'high',
          summary: 'The margin is below the published floor.',
          blocking: true,
        },
        {
          reason: 'price_exception',
          riskLevel: 'high',
          summary: 'The manual price adjustment is outside automatic policy.',
          blocking: true,
        },
        {
          reason: 'uncertain_scope',
          riskLevel: 'high',
          summary: 'Scope evidence contains unresolved unknowns.',
          blocking: true,
        },
      ],
    };
    const state = mapLiveWorkspace({
      schemaVersion: 'storyops-workspace-v1',
      serverTime: '2026-07-30T20:00:00.000Z',
      session: { userId: ownerId, companyId, role: 'owner' },
      company: {
        id: companyId,
        name: 'Exact Approval Exterior Co',
        timezone: 'America/Chicago',
        currency: 'USD',
        status: 'active',
        settings: {},
        version: 1,
      },
      approvals: [
        {
          id: approvalId,
          reason: 'large_discount',
          risk_level: 'high',
          status: 'pending',
          requested_at: '2026-07-30T20:00:00.000Z',
          expires_at: '2026-07-31T20:00:00.000Z',
          entity_type: 'estimate',
          entity_id: estimateId,
          action_type: 'estimate.approve_exception',
          summary: '4 blocking estimate exceptions require owner review of the exact payload.',
          policy_version: 'storyops-policy-v1.0.0',
          payloadHash,
          exactPayload,
          version: 1,
        },
      ],
    });

    expect(state.approvals).toHaveLength(1);
    const approval = state.approvals[0]!;
    expect(approval).toMatchObject({
      id: approvalId,
      risk: 'high',
      payloadHash,
      blockingFlags: [
        { reason: 'large_discount', riskLevel: 'high' },
        { reason: 'margin_below_floor', riskLevel: 'high' },
        { reason: 'price_exception', riskLevel: 'high' },
        { reason: 'uncertain_scope', riskLevel: 'high' },
      ],
    });
    expect(JSON.parse(approval.payloadPreview)).toEqual(exactPayload);
  });
});
