import type { LiveWorkspaceMetadata } from '@/state/model';

export type PostServiceFollowupStatus = Exclude<
  LiveWorkspaceMetadata['postServiceReviewStatus'],
  undefined
>;

export function postServiceFollowupLabel(
  subject: 'Review' | 'Referral',
  status: PostServiceFollowupStatus | undefined,
  idleLabel: string,
): string {
  switch (status) {
    case 'queued':
      return `${subject} SMS queued`;
    case 'submitted':
      return `${subject} SMS submitted — awaiting delivery`;
    case 'reconciliation_required':
      return `${subject} SMS accepted — delivery reconciliation required`;
    case 'submitted_unknown':
      return `${subject} send status unknown — reconciliation required`;
    case 'completed':
      return `${subject} SMS delivered`;
    case 'sandboxed':
      return `${subject} sandboxed — no SMS sent`;
    case 'failed':
      return `${subject} SMS failed`;
    case 'cancelled':
      return `${subject} SMS cancelled`;
    default:
      return idleLabel;
  }
}

export function hasUnknownPostServiceSubmission(
  ...statuses: Array<PostServiceFollowupStatus | undefined>
): boolean {
  return statuses.includes('submitted_unknown');
}

export function hasPostServiceReconciliationRequired(
  ...statuses: Array<PostServiceFollowupStatus | undefined>
): boolean {
  return statuses.some(
    (status) => status === 'submitted_unknown' || status === 'reconciliation_required',
  );
}
