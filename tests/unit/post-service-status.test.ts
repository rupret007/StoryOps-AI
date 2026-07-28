import { describe, expect, it } from 'vitest';
import {
  hasPostServiceReconciliationRequired,
  hasUnknownPostServiceSubmission,
  postServiceFollowupLabel,
} from '../../src/utils/postServiceStatus';

describe('post-service status labels', () => {
  it('renders unknown live submissions as reconciliation work, never queued or delivered', () => {
    const label = postServiceFollowupLabel('Review', 'submitted_unknown', 'Queue my review SMS');

    expect(label).toBe('Review send status unknown — reconciliation required');
    expect(label.toLowerCase()).not.toContain('queued');
    expect(label.toLowerCase()).not.toContain('delivered');
    expect(hasUnknownPostServiceSubmission('submitted_unknown', 'completed')).toBe(true);
  });

  it('keeps sandbox and provider-confirmed states explicit', () => {
    expect(postServiceFollowupLabel('Referral', 'sandboxed', 'Queue referral SMS')).toBe(
      'Referral sandboxed — no SMS sent',
    );
    expect(postServiceFollowupLabel('Referral', 'completed', 'Queue referral SMS')).toBe(
      'Referral SMS delivered',
    );
  });

  it('does not call an accepted message failed when delivery reconciliation is exhausted', () => {
    const label = postServiceFollowupLabel(
      'Review',
      'reconciliation_required',
      'Queue my review SMS',
    );

    expect(label).toBe('Review SMS accepted — delivery reconciliation required');
    expect(label.toLowerCase()).not.toContain('failed');
    expect(label.toLowerCase()).not.toContain('delivered');
    expect(hasUnknownPostServiceSubmission('reconciliation_required')).toBe(false);
    expect(hasPostServiceReconciliationRequired('reconciliation_required')).toBe(true);
  });
});
