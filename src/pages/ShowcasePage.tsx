import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  RefreshCcw,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { Link, useLocation } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import type { AppRole } from '@/state/model';
import { Badge, Button, Card, PageHeader, Progress } from '@/components/ui/Primitives';
import { deriveShowcaseManifest } from '@/core/pilot/showcase';

function checkpointTone(
  status: 'complete' | 'current' | 'blocked',
): 'positive' | 'warning' | 'neutral' {
  return status === 'complete' ? 'positive' : status === 'current' ? 'warning' : 'neutral';
}

function checkpointTitle(status: 'complete' | 'current' | 'blocked'): string {
  return status === 'complete' ? 'Recorded' : status === 'current' ? 'Next' : 'Blocked';
}

type ShowcaseCheckpoint = ReturnType<typeof deriveShowcaseManifest>['checkpoints'][number];

function reconcileRoleProgress(
  checkpoints: ShowcaseCheckpoint[],
  role: AppRole,
): ShowcaseCheckpoint[] {
  const roleRelevant = checkpoints.filter((checkpoint) => checkpoint.role.includes(role));
  const nextIndex = roleRelevant.findIndex((checkpoint) => checkpoint.status !== 'complete');
  return roleRelevant.map((checkpoint, index) => {
    if (checkpoint.status === 'complete') return checkpoint;
    return {
      ...checkpoint,
      status: index === nextIndex ? 'current' : 'blocked',
    };
  });
}

function routeForRole(role: string, checkpointId: string): string {
  if (role === 'customer' && checkpointId === 'quote-and-terms') return '/portal';
  return '/';
}

export function ShowcasePage() {
  const { state, actions } = useStoryOps();
  const location = useLocation();
  const badge = actions.getShowcaseBadge();
  const manifest = actions.getShowcaseTourState();
  const routeManifest = deriveShowcaseManifest(state);
  const manifestToUse = routeManifest.completeCount ? routeManifest : manifest;

  const roleCheckpoints = reconcileRoleProgress(manifestToUse.checkpoints, state.role);
  const roleCurrent = roleCheckpoints.find((checkpoint) => checkpoint.status === 'current');

  const current = roleCurrent ?? manifestToUse.whatIsNext;
  const nextHref = current?.href ?? '/';

  return (
    <div className="page showcase-page">
      <PageHeader
        eyebrow="WashOps · v1.2 showcase"
        title="8-0-1 Guided demo run"
        description="Use this deterministic, local-only route to rehearse the full exterior-services startup flow. No customer data is real and every external claim is explicitly sandbox-tagged."
        actions={
          <>
            <Badge tone="dark" dot>
              {badge.label}
            </Badge>
            <Button
              variant="secondary"
              icon={<RefreshCcw size={15} />}
              onClick={() => actions.resetShowcaseData()}
            >
              Reset Showcase Data
            </Button>
            <Link className="button button--dark button--sm" to="/">
              <ArrowLeft size={14} aria-hidden="true" />
              Exit to command center
            </Link>
          </>
        }
      />

      <section className="dashboard-grid">
        <div className="dashboard-stack">
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Showcase progress for {state.role}</h2>
                <p className="section-card__subtitle">
                  Route: /{location.pathname} • Source: {manifestToUse.source}
                </p>
              </div>
              <Badge tone="accent">{manifestToUse.completeCount}/6 local fixtures</Badge>
            </div>
            <Progress
              value={manifestToUse.completeCount}
              max={manifestToUse.checkpoints.length}
              label="Showcase milestone progress"
              tone="green"
            />
            <ul className="briefing-list">
              {roleCheckpoints.map((checkpoint) => (
                <li className="briefing-item" key={checkpoint.id}>
                  <span className="briefing-item__icon">
                    {checkpoint.status === 'complete' ? (
                      <CheckCircle2 size={14} />
                    ) : (
                      <ShieldAlert size={14} />
                    )}
                  </span>
                  <div>
                    <p className="briefing-item__title">{checkpoint.title}</p>
                    <p className="briefing-item__detail">{checkpoint.summary}</p>
                    <small className="briefing-item__source">{checkpoint.detail}</small>
                    <small className="briefing-item__source">
                      Evidence: {checkpoint.evidenceSources.join(' · ')}
                    </small>
                  </div>
                  <Badge tone={checkpointTone(checkpoint.status)}>
                    {checkpointTitle(checkpoint.status)}
                  </Badge>
                </li>
              ))}
            </ul>
            {manifestToUse.whatIsNext && (
              <>
                <Link
                  className="button button--dark button--md full-width"
                  to={nextHref}
                  title={manifestToUse.whatIsNext.detail}
                >
                  {manifestToUse.whatIsNext.actionLabel ??
                    `Go to ${manifestToUse.whatIsNext.title}`}
                  <CalendarClock size={14} aria-hidden="true" />
                </Link>
                <p className="briefing-unknowns">
                  <strong>Next actions:</strong> {manifestToUse.whatIsNext.actions.join(' · ')}
                </p>
              </>
            )}
            <p className="briefing-unknowns">
              <strong>Route path:</strong> {manifestToUse.route}
            </p>
          </Card>

          <Card className="section-card">
            <div className="section-card__header">
              <h2>What happens next</h2>
              <Badge tone={manifestToUse.whatIsNext?.status === 'current' ? 'warning' : 'neutral'}>
                {manifestToUse.whatIsNext
                  ? `${manifestToUse.whatIsNext.role[0]} path`
                  : 'Flow complete'}
              </Badge>
            </div>
            <div className="briefing-item__detail">
              <p>
                {manifestToUse.whatIsNext
                  ? `${manifestToUse.whatIsNext.summary} This stage requires the actor to continue in-role and follow visible guardrails.`
                  : 'The six-stage showcase route is complete. No further synthetic actions are required.'}
              </p>
              {manifestToUse.whatIsNext && (
                <>
                  <p>
                    Role gate: <strong>{manifestToUse.whatIsNext.role.join(', ')}</strong>
                  </p>
                  <p>
                    Requires approval gate:{' '}
                    <strong>{manifestToUse.whatIsNext.requiresApproval ? 'Yes' : 'No'}</strong>
                  </p>
                  <p>
                    Current actor route: {routeForRole(state.role, manifestToUse.whatIsNext.id)}
                  </p>
                </>
              )}
            </div>
          </Card>
        </div>

        <Card className="briefing-card">
          <div className="section-card__header">
            <div>
              <h2>Safety boundaries and known unknowns</h2>
              <p className="briefing-card__meta">Scope for all roles</p>
            </div>
            <Badge tone="accent">DEMO</Badge>
          </div>
          <ul className="briefing-list">
            {badge.policyBoundaries.map((policy) => (
              <li className="briefing-item" key={policy}>
                <span className="briefing-item__icon">
                  <CircleAlert size={14} />
                </span>
                <div>
                  <p className="briefing-item__title">Policy boundary</p>
                  <p className="briefing-item__detail">{policy}</p>
                </div>
              </li>
            ))}
            {manifestToUse.uncertainty.length > 0 && (
              <li className="briefing-unknowns">
                <details>
                  <summary>Uncertainty notes ({manifestToUse.uncertainty.length})</summary>
                  <ul>
                    {manifestToUse.uncertainty.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                </details>
              </li>
            )}
          </ul>
          <div className="briefing-item">
            <span className="briefing-item__icon">
              <Users size={14} />
            </span>
            <div>
              <p className="briefing-item__title">Role clarity</p>
              <p className="briefing-item__detail">
                Owner, dispatcher, technician, and customer roles have dedicated screens. Use role
                preview controls in the top bar or mobile menu.
              </p>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
