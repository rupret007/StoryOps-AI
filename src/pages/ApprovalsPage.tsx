import {
  Ban,
  Check,
  Clock3,
  FileLock2,
  History,
  Megaphone,
  MessageSquareWarning,
  ShieldCheck,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui/Primitives';

const reasonIcon = {
  large_discount: FileLock2,
  negative_review_response: MessageSquareWarning,
  refund: History,
  safety_message: ShieldCheck,
  campaign_send: Megaphone,
  other: ShieldCheck,
};

const executableApprovedActionTypes = new Set([
  'payments.refund',
  'records.create_lead',
  'records.update_lead',
]);

function executeActionLabel(actionType?: string): string {
  if (actionType === 'records.create_lead') return 'Create approved lead';
  if (actionType === 'records.update_lead') return 'Apply approved lead status';
  return 'Execute approved refund';
}

export function ApprovalsPage() {
  const { state, actions } = useStoryOps();
  const [showDecided, setShowDecided] = useState(false);
  const pending = state.approvals.filter((approval) => approval.status === 'pending');
  const decided = state.approvals.filter((approval) => approval.status !== 'pending');
  const items = showDecided ? decided : pending;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Human control"
        title="Approve the exact action—not a vague intention"
        description="Every request includes the record version, proposed payload, risk, reason, expiry, and policy version. Editing creates a new proposal."
        actions={
          <div className="segmented">
            <button type="button" aria-pressed={!showDecided} onClick={() => setShowDecided(false)}>
              Pending · {pending.length}
            </button>
            <button type="button" aria-pressed={showDecided} onClick={() => setShowDecided(true)}>
              Decided · {decided.length}
            </button>
          </div>
        }
      />

      <Card className="approval-policy-banner">
        <span>
          <ShieldCheck size={20} />
        </span>
        <div>
          <h2>Policy boundary is active</h2>
          <p>
            Price exceptions, large discounts, refunds, legal or safety messages, negative-review
            replies, vendor/bank actions, destructive changes, campaigns, and work outside approved
            price books or SOPs pause here.
          </p>
        </div>
        <Badge tone="positive" dot>
          storyops-policy-v1.0.0
        </Badge>
      </Card>

      <div className="approval-page-list">
        {items.map((approval) => {
          const Icon = reasonIcon[approval.reason];
          return (
            <Card className="approval-detail-card" key={approval.id}>
              <div className="approval-detail-card__heading">
                <span className="approval-card__icon">
                  <Icon size={17} />
                </span>
                <div>
                  <div className="approval-detail-card__title-row">
                    <h2>{approval.title}</h2>
                    <Badge
                      tone={
                        approval.risk === 'high' || approval.risk === 'critical'
                          ? 'danger'
                          : 'warning'
                      }
                    >
                      {approval.risk} risk
                    </Badge>
                  </div>
                  <p>{approval.summary}</p>
                </div>
              </div>
              {(approval.blockingFlags?.length ?? 0) > 0 && (
                <section
                  className="approval-blockers"
                  aria-label={`Blocking reasons for ${approval.title}`}
                >
                  <h3>Every blocking reason</h3>
                  <ul>
                    {approval.blockingFlags?.map((flag) => (
                      <li key={`${flag.reason}:${flag.summary}`}>
                        <div>
                          <code>{flag.reason}</code>
                          <Badge
                            tone={
                              flag.riskLevel === 'high' || flag.riskLevel === 'critical'
                                ? 'danger'
                                : 'warning'
                            }
                          >
                            {flag.riskLevel}
                          </Badge>
                        </div>
                        <p>{flag.summary}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <div className="approval-payload">
                <div>
                  <span>Exact payload</span>
                  <pre>
                    <code>{approval.payloadPreview}</code>
                  </pre>
                </div>
                <div>
                  <span>SHA-256 payload hash</span>
                  <code>{approval.payloadHash ?? 'No executable payload hash'}</code>
                </div>
                <div>
                  <span>Entity</span>
                  <code>{approval.entityId}</code>
                </div>
                <div>
                  <span>Policy</span>
                  <code>{approval.policyVersion}</code>
                </div>
              </div>
              <div className="approval-detail-card__footer">
                <div className="approval-time">
                  <Clock3 size={13} />
                  Requested {approval.requestedAt} · expires {approval.expiresAt}
                </div>
                {approval.status === 'pending' ? (
                  <div className="approval-card__actions">
                    <Button
                      variant="secondary"
                      onClick={() => actions.decideApproval(approval.id, 'rejected')}
                      icon={<Ban size={14} />}
                    >
                      Reject
                    </Button>
                    <Button
                      variant="dark"
                      onClick={() => actions.decideApproval(approval.id, 'approved')}
                      icon={<Check size={14} />}
                    >
                      Approve exact payload
                    </Button>
                  </div>
                ) : (
                  <div className="approval-card__actions">
                    <Badge tone={approval.status === 'approved' ? 'positive' : 'danger'} dot>
                      {approval.status} by owner
                    </Badge>
                    {state.dataMode === 'supabase' &&
                      approval.status === 'approved' &&
                      executableApprovedActionTypes.has(approval.actionType ?? '') &&
                      (approval.consumedAt ? (
                        <Badge tone="positive">Executed exactly once</Badge>
                      ) : (
                        <Button
                          variant="dark"
                          onClick={() => actions.executeApprovedAction(approval.id)}
                          icon={<Check size={14} />}
                        >
                          {executeActionLabel(approval.actionType)}
                        </Button>
                      ))}
                    {state.dataMode === 'supabase' &&
                      approval.status === 'approved' &&
                      approval.actionType === 'payment.allocation.apply_exact_current_balance' &&
                      (approval.consumedAt ? (
                        <Badge tone="positive">Applied exactly once</Badge>
                      ) : (
                        <Link className="button button--dark button--md" to="/finance">
                          Verify note & apply in Finance
                        </Link>
                      ))}
                    {state.dataMode === 'supabase' &&
                      approval.status === 'approved' &&
                      approval.actionType === 'payment.allocation.review_manual' && (
                        <Badge tone="warning">
                          No automatic resolver · provider/accounting work required
                        </Badge>
                      )}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {items.length === 0 && (
        <Card>
          <EmptyState
            icon={<ShieldCheck size={22} />}
            title={showDecided ? 'No decided items yet' : 'Approval queue is clear'}
            description={
              showDecided
                ? 'Owner decisions will remain visible with immutable audit references.'
                : 'AI and automations may continue only within their low-risk, reversible allowlist.'
            }
          />
        </Card>
      )}
    </div>
  );
}
