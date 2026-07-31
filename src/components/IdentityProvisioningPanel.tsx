import { useMemo, useState, type FormEvent } from 'react';
import {
  KeyRound,
  Link2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import {
  normalizeIdentityEmail,
  type IdentityProvisioningInput,
  type IdentityProvisioningReceipt,
  type IdentityProvisioningRole,
  type IdentityProvisioningState,
} from '@/core/identity/provisioning';
import { Badge, Button, Card, Field, PageHeader } from '@/components/ui/Primitives';

export interface IdentityProvisioningPanelProps {
  state: IdentityProvisioningState;
  online: boolean;
  serverVerified: boolean;
  busy: boolean;
  error?: string;
  lastReceipt?: IdentityProvisioningReceipt;
  onRefresh(): Promise<void>;
  onCommand(input: IdentityProvisioningInput): Promise<void>;
}

const roleLabel: Record<IdentityProvisioningRole, string> = {
  dispatcher: 'Dispatcher',
  technician: 'Technician',
  customer: 'Customer portal',
};

const outcomeMessage: Record<IdentityProvisioningReceipt['outcomeCode'], string> = {
  invite_delivery_disabled:
    'Invite delivery is disabled. No external email was submitted and no access was granted.',
  existing_identity_requires_link:
    'An exact existing auth identity was found. No email was sent; link it only after confirmation.',
  invite_submission_accepted:
    'The auth provider accepted the invite submission. Inbox delivery and active access are not claimed.',
  invite_submission_failed:
    'The auth provider did not accept the invite submission. No access was granted.',
  invite_submission_unknown:
    'The invite attempt began, but provider acceptance is unknown. Do not resend; reconcile the exact identity first.',
  identity_not_found:
    'No exact auth identity was found. Invite it first or verify the normalized email.',
  identity_confirmation_required:
    'The exact auth identity exists but its email is not confirmed. Access remains blocked.',
  identity_linked: 'The exact confirmed identity and requested tenant binding are active.',
  identity_revoked:
    'The exact tenant binding was revoked. The shared auth identity was not deleted.',
};

function statusTone(
  status: IdentityProvisioningState['targets'][number]['status'],
): 'warning' | 'info' | 'positive' | 'neutral' {
  if (status === 'linked') return 'positive';
  if (status === 'invited') return 'info';
  if (status === 'pending') return 'warning';
  return 'neutral';
}

export function IdentityProvisioningPanel({
  state,
  online,
  serverVerified,
  busy,
  error,
  lastReceipt,
  onRefresh,
  onCommand,
}: IdentityProvisioningPanelProps) {
  const [action, setAction] = useState<'invite' | 'link' | 'revoke'>('invite');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<IdentityProvisioningRole>('technician');
  const [customerId, setCustomerId] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const activeCompany = state.companyStatus === 'active';
  const mayMutate = activeCompany && online && serverVerified && !busy;
  const normalizedEmail = useMemo(() => {
    try {
      return normalizeIdentityEmail(email);
    } catch {
      return undefined;
    }
  }, [email]);
  const selectedCustomer = state.customers.find((customer) => customer.id === customerId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!normalizedEmail) {
      setValidationError('Enter a valid email address.');
      return;
    }
    if (role === 'customer' && !selectedCustomer) {
      setValidationError('Choose the exact customer account for this portal identity.');
      return;
    }
    if (!mayMutate) {
      setValidationError(
        'Identity changes require an online, server-verified owner session and an active company.',
      );
      return;
    }
    setValidationError(undefined);
    await onCommand({
      action,
      email: normalizedEmail,
      role,
      customerId: role === 'customer' ? selectedCustomer?.id : undefined,
    });
  };

  const selectTarget = (
    target: IdentityProvisioningState['targets'][number],
    nextAction: 'link' | 'revoke',
  ) => {
    setAction(nextAction);
    setEmail(target.email);
    setRole(target.role);
    setCustomerId(target.customerId ?? '');
    setValidationError(undefined);
    document.getElementById('identity-email')?.focus();
  };

  const selectUnresolvedAttempt = (
    attempt: IdentityProvisioningState['unresolvedAttempts'][number],
  ) => {
    setAction('invite');
    setEmail(attempt.email);
    setRole(attempt.originatingRole);
    setCustomerId(attempt.originatingCustomerId ?? '');
    setValidationError(undefined);
    document.getElementById('identity-email')?.focus();
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Owner-only access"
        title="Identity provisioning"
        description="Invite, link, or revoke one exact normalized identity. Invitation submission is not delivery, and access is not active until a confirmed identity is explicitly linked."
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw size={15} aria-hidden="true" />}
            disabled={!online || busy}
            loading={busy}
            onClick={() => void onRefresh()}
          >
            Refresh access state
          </Button>
        }
      />

      <div role="region" aria-label="Identity authority status">
        <Card className="integration-health-banner">
          <span className="integration-health-banner__icon">
            <ShieldCheck size={22} aria-hidden="true" />
          </span>
          <div>
            <h2>Trusted server boundary</h2>
            <p>
              {state.inviteMode === 'live'
                ? 'Supabase Auth invitation submission is explicitly enabled. Provider acceptance still does not prove inbox delivery or account activation.'
                : 'Invitation delivery is disabled. Exact existing identities can be reconciled, but this app will not submit external invite email.'}
            </p>
          </div>
          <Badge tone={state.inviteMode === 'live' ? 'warning' : 'info'} dot>
            {state.inviteMode === 'live' ? 'Invite submission enabled' : 'No external invite'}
          </Badge>
        </Card>
      </div>

      {(!activeCompany || !online || !serverVerified) && (
        <Card className="integration-health-banner" as="div">
          <span className="integration-health-banner__icon">
            <KeyRound size={22} aria-hidden="true" />
          </span>
          <div role="alert">
            <h2>Identity changes blocked</h2>
            <p>
              {!activeCompany
                ? `Company status is ${state.companyStatus}. Reactivate operations before changing access.`
                : !online
                  ? 'This device is offline. Identity access never queues for later replay.'
                  : 'Refresh the authenticated server workspace before changing access.'}
            </p>
          </div>
        </Card>
      )}

      {error && (
        <div className="company-control-error" role="alert">
          <strong>Identity access needs attention</strong>
          <span>{error}</span>
        </div>
      )}

      {lastReceipt && (
        <div role="region" aria-label="Latest identity command result">
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Latest command</h2>
                <p className="section-card__subtitle">
                  Server-confirmed status for {lastReceipt.email}
                </p>
              </div>
              <Badge tone={statusTone(lastReceipt.status)} dot>
                {lastReceipt.status}
              </Badge>
            </div>
            <p>{outcomeMessage[lastReceipt.outcomeCode]}</p>
            <p className="company-control-note">
              Delivery: {lastReceipt.deliveryStatus.replaceAll('_', ' ')} · membership{' '}
              {lastReceipt.membershipActive ? 'active' : 'inactive'} · portal mapping{' '}
              {lastReceipt.portalLinked ? 'active' : 'inactive'} · external delivery claimed: no
            </p>
          </Card>
        </div>
      )}

      {state.unresolvedAttempts.length > 0 && (
        <div role="region" aria-label="Unresolved invitation attempts">
          <Card className="section-card">
            <div className="section-card__header">
              <div>
                <h2>Invitation reconciliation required</h2>
                <p className="section-card__subtitle">
                  Provider authority is held; duplicate invite submission is blocked
                </p>
              </div>
              <ShieldAlert size={19} aria-hidden="true" />
            </div>
            <p className="company-control-note">
              Locate the exact identity after provider state may have changed. Until the displayed
              retry time, StoryOps will not submit another invite for this email. Preparing the
              action below does not contact the provider.
            </p>
            {state.unresolvedAttempts.map((attempt) => (
              <div className="template-row" key={attempt.id}>
                <span>
                  <strong>{attempt.email}</strong>
                  <small>
                    Originating {roleLabel[attempt.originatingRole]} · claimed{' '}
                    {new Date(attempt.authorizedAt).toLocaleString()} · retry{' '}
                    {attempt.retryEligible
                      ? 'eligible after owner review'
                      : `blocked until ${new Date(attempt.expiresAt).toLocaleString()}`}
                  </small>
                </span>
                <div className="page-header__actions">
                  <Badge tone="warning">{attempt.authorityStatus.replaceAll('_', ' ')}</Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!mayMutate}
                    onClick={() => selectUnresolvedAttempt(attempt)}
                  >
                    Prepare exact lookup
                  </Button>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}

      <div className="settings-grid">
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Exact access command</h2>
              <p className="section-card__subtitle">
                Owner intent is full-request hashed and audited
              </p>
            </div>
            <UserPlus size={19} aria-hidden="true" />
          </div>
          <form onSubmit={(event) => void submit(event)}>
            <Field label="Action" htmlFor="identity-action">
              <select
                id="identity-action"
                className="select"
                value={action}
                disabled={busy}
                onChange={(event) => setAction(event.target.value as 'invite' | 'link' | 'revoke')}
              >
                <option value="invite">Invite or locate</option>
                <option value="link">Link confirmed identity</option>
                <option value="revoke">Revoke exact binding</option>
              </select>
            </Field>
            <Field
              label="Exact email"
              htmlFor="identity-email"
              hint="The server normalizes and rechecks this email against Supabase Auth."
            >
              <input
                id="identity-email"
                className="input"
                type="email"
                autoComplete="off"
                maxLength={254}
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Role" htmlFor="identity-role">
              <select
                id="identity-role"
                className="select"
                value={role}
                disabled={busy}
                onChange={(event) => {
                  const nextRole = event.target.value as IdentityProvisioningRole;
                  setRole(nextRole);
                  if (nextRole !== 'customer') setCustomerId('');
                }}
              >
                <option value="dispatcher">Dispatcher</option>
                <option value="technician">Technician</option>
                <option value="customer">Customer portal</option>
              </select>
            </Field>
            {role === 'customer' && (
              <Field
                label="Exact customer account"
                htmlFor="identity-customer"
                hint="One portal binding is created or revoked; customer data is never inferred from email."
              >
                <select
                  id="identity-customer"
                  className="select"
                  value={customerId}
                  disabled={busy}
                  onChange={(event) => setCustomerId(event.target.value)}
                >
                  <option value="">Choose a customer</option>
                  {state.customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.displayName}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {validationError && (
              <p className="field__error" role="alert">
                {validationError}
              </p>
            )}
            <Button
              type="submit"
              variant={action === 'revoke' ? 'danger' : 'primary'}
              disabled={!mayMutate || !normalizedEmail}
              loading={busy}
              icon={
                action === 'revoke' ? (
                  <UserMinus size={15} aria-hidden="true" />
                ) : action === 'link' ? (
                  <Link2 size={15} aria-hidden="true" />
                ) : (
                  <UserPlus size={15} aria-hidden="true" />
                )
              }
            >
              {action === 'invite'
                ? 'Submit invite or locate'
                : action === 'link'
                  ? 'Link exact identity'
                  : 'Revoke exact binding'}
            </Button>
          </form>
        </Card>

        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Truth model</h2>
              <p className="section-card__subtitle">What each status does—and does not—prove</p>
            </div>
            <ShieldCheck size={19} aria-hidden="true" />
          </div>
          <div className="template-row">
            <span>
              <strong>Pending</strong>
              <small>No active binding. Follow the recorded next action.</small>
            </span>
          </div>
          <div className="template-row">
            <span>
              <strong>Invited</strong>
              <small>Provider accepted submission; inbox delivery is unknown.</small>
            </span>
          </div>
          <div className="template-row">
            <span>
              <strong>Linked</strong>
              <small>Confirmed auth email and exact tenant binding are active.</small>
            </span>
          </div>
          <div className="template-row">
            <span>
              <strong>Revoked</strong>
              <small>Tenant access is off; the shared auth identity is retained.</small>
            </span>
          </div>
        </Card>
      </div>

      <Card className="section-card">
        <div className="section-card__header">
          <div>
            <h2>Provisioned identities</h2>
            <p className="section-card__subtitle">
              Current server state · {state.targets.length} exact binding
              {state.targets.length === 1 ? '' : 's'}
            </p>
          </div>
          <KeyRound size={19} aria-hidden="true" />
        </div>
        {state.targets.length === 0 ? (
          <div className="empty-state">
            <KeyRound className="empty-state__icon" aria-hidden="true" />
            <h3>No provisioned identities</h3>
            <p>Invite or locate one exact email to begin the access workflow.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Identity</th>
                  <th scope="col">Binding</th>
                  <th scope="col">Status</th>
                  <th scope="col">Delivery</th>
                  <th scope="col">Access</th>
                  <th scope="col">Owner action</th>
                </tr>
              </thead>
              <tbody>
                {state.targets.map((target) => (
                  <tr key={target.id}>
                    <td>
                      <strong>{target.email}</strong>
                      <span className="table-subtext">
                        Updated {new Date(target.updatedAt).toLocaleString()}
                      </span>
                    </td>
                    <td>
                      {roleLabel[target.role]}
                      {target.customerDisplayName && (
                        <span className="table-subtext">{target.customerDisplayName}</span>
                      )}
                    </td>
                    <td>
                      <Badge tone={statusTone(target.status)}>{target.status}</Badge>
                    </td>
                    <td>
                      {target.deliveryStatus.replaceAll('_', ' ')}
                      <span className="table-subtext">Delivery claimed: no</span>
                    </td>
                    <td>
                      Membership {target.membershipActive ? 'active' : 'inactive'}
                      {target.role === 'customer' && (
                        <span className="table-subtext">
                          Portal {target.portalLinked ? 'active' : 'inactive'}
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="page-header__actions">
                        {target.status !== 'linked' && target.status !== 'revoked' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!mayMutate}
                            onClick={() => selectTarget(target, 'link')}
                          >
                            Prepare link
                          </Button>
                        )}
                        {target.status !== 'revoked' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!mayMutate}
                            onClick={() => selectTarget(target, 'revoke')}
                          >
                            Prepare revoke
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
