import {
  ArrowRight,
  Check,
  ChevronLeft,
  CircleDollarSign,
  Droplets,
  Home,
  MapPinned,
  MessageSquareText,
  ShieldCheck,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import type { SandboxServiceCode } from '@/state/model';
import { Badge, Button, Field } from '@/components/ui/Primitives';

const steps = ['Business', 'Services', 'Policy', 'Launch'];

export function SetupPage() {
  const { state, actions } = useStoryOps();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [businessName, setBusinessName] = useState(
    state.setupProfile?.businessName ??
      (state.dataMode === 'supabase' ? '' : 'Story Exterior Care'),
  );
  const [ownerName, setOwnerName] = useState(
    state.setupProfile?.ownerName ?? (state.dataMode === 'supabase' ? '' : 'Jeff Story'),
  );
  const [homePostalCode, setHomePostalCode] = useState(
    state.setupProfile?.homePostalCode ?? (state.dataMode === 'supabase' ? '' : '76051'),
  );
  const [services, setServices] = useState<SandboxServiceCode[]>([
    ...(state.setupProfile?.enabledServiceCodes ?? ['pressure-wash-flatwork', 'gutter-cleaning']),
  ]);
  const [policyAcknowledged, setPolicyAcknowledged] = useState(
    state.setupProfile?.policyAcknowledged ?? false,
  );
  const [validationError, setValidationError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  const toggleService = (service: SandboxServiceCode) => {
    setValidationError(undefined);
    setServices((current) =>
      current.includes(service)
        ? current.filter((item) => item !== service)
        : [...current, service],
    );
  };

  const next = async () => {
    const error =
      step === 0
        ? businessName.trim().length < 2 || businessName.trim().length > 80
          ? 'Business name must be 2–80 characters.'
          : ownerName.trim().length < 2 || ownerName.trim().length > 80
            ? 'Owner name must be 2–80 characters.'
            : !/^\d{5}$/u.test(homePostalCode.trim())
              ? 'Enter a five-digit home ZIP code.'
              : undefined
        : step === 1 && services.length === 0
          ? 'Select at least one service before continuing.'
          : step === 2 && !policyAcknowledged
            ? `Acknowledge the ${state.dataMode === 'supabase' ? 'live setup' : 'sandbox'} policy boundary before continuing.`
            : undefined;
    if (error) {
      setValidationError(error);
      return;
    }
    setValidationError(undefined);
    if (step < steps.length - 1) {
      setStep((current) => current + 1);
    } else {
      setSubmitting(true);
      try {
        const completed = await actions.completeSetup({
          businessName,
          ownerName,
          homePostalCode,
          timezone: 'America/Chicago',
          enabledServiceCodes: services,
          policyAcknowledged: true,
        });
        if (completed) {
          navigate('/');
        } else {
          setValidationError(
            'Setup was not confirmed by the server. No completed workspace is being claimed.',
          );
        }
      } catch (error) {
        setValidationError(
          error instanceof Error
            ? error.message
            : 'Setup was not confirmed by the server. No completed workspace is being claimed.',
        );
      } finally {
        setSubmitting(false);
      }
    }
  };

  return (
    <div className="setup-shell">
      <aside className="setup-aside">
        <div className="portal-brand">
          <span className="brand__mark">
            <Sparkles size={17} />
          </span>
          StoryOps AI
        </div>
        <h1>Your back office, safely on duty.</h1>
        <p>
          {state.dataMode === 'supabase'
            ? 'This authenticated setup provisions one owner-scoped company, selected inactive services, review-required drafts, and disabled optional providers. The private Supabase field-media data plane is a separate mandatory workspace dependency. Setup cannot publish pricing or terms, authorize launch, contact a customer, or charge a card.'
            : 'This guided setup records a local sandbox profile and constrains its seeded DFW price book to the services you select. It does not provision a live company, contact a customer, or charge a card.'}
        </p>
        <div className="setup-aside__safety">
          <ShieldCheck size={18} />
          <span>
            AI can only auto-run low-risk, reversible actions allowed by your published policy.
          </span>
        </div>
      </aside>
      <main className="setup-main" id="main-content">
        <div className="setup-form">
          <div className="setup-progress" aria-label={`Setup step ${step + 1} of ${steps.length}`}>
            {steps.map((label, index) => (
              <span className={index <= step ? 'complete' : ''} key={label} title={label} />
            ))}
          </div>
          <p className="eyebrow">
            Step {step + 1} of {steps.length} · {steps[step]}
          </p>

          {step === 0 && (
            <>
              <h1>Tell StoryOps who it works for.</h1>
              <p className="setup-description">
                Single-company V1. You can change these settings later; the audit trail records
                policy-impacting changes.
              </p>
              <div className="input-group">
                <Field label="Business name" htmlFor="business-name">
                  <input
                    id="business-name"
                    className="input"
                    value={businessName}
                    maxLength={80}
                    required
                    onChange={(event) => {
                      setBusinessName(event.target.value);
                      setValidationError(undefined);
                    }}
                  />
                </Field>
                <Field label="Owner name" htmlFor="owner-name">
                  <input
                    id="owner-name"
                    className="input"
                    value={ownerName}
                    maxLength={80}
                    required
                    onChange={(event) => {
                      setOwnerName(event.target.value);
                      setValidationError(undefined);
                    }}
                  />
                </Field>
                <Field label="Home ZIP code" htmlFor="zip">
                  <input
                    id="zip"
                    className="input"
                    value={homePostalCode}
                    inputMode="numeric"
                    pattern="[0-9]{5}"
                    maxLength={5}
                    required
                    onChange={(event) => {
                      setHomePostalCode(event.target.value);
                      setValidationError(undefined);
                    }}
                  />
                </Field>
                <Field label="Timezone" htmlFor="timezone">
                  <select id="timezone" className="select" defaultValue="America/Chicago">
                    <option value="America/Chicago">America/Chicago · Central</option>
                  </select>
                </Field>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h1>Choose the services you perform now.</h1>
              <p className="setup-description">
                Only published services can be priced or booked. Add-ons stay constrained to their
                parent service.
              </p>
              <div className="setup-option-grid">
                {(
                  [
                    [
                      'pressure-wash-flatwork',
                      'Pressure washing',
                      'Driveways, patios, hardscape',
                      Droplets,
                    ],
                    [
                      'soft-wash-house',
                      'Soft washing',
                      'Exterior siding and approved surfaces',
                      Home,
                    ],
                    [
                      'gutter-cleaning',
                      'Gutter cleaning',
                      'Gutters and downspout flow test',
                      Wrench,
                    ],
                  ] as Array<[SandboxServiceCode, string, string, LucideIcon]>
                ).map(([id, name, detail, Icon]) => (
                  <button
                    className="setup-option"
                    type="button"
                    key={id}
                    aria-pressed={services.includes(id)}
                    onClick={() => toggleService(id)}
                  >
                    <span className="setup-option__icon">
                      <Icon size={18} />
                    </span>
                    <strong>{name}</strong>
                    <small>{detail}</small>
                    {services.includes(id) && <Check size={16} />}
                  </button>
                ))}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h1>Review the starter policy.</h1>
              <p className="setup-description">
                {state.dataMode === 'supabase'
                  ? 'These values create non-operational setup drafts only. No price book, terms, retention policy, service, provider, or launch permission is approved by this acknowledgement.'
                  : 'These are conservative sandbox defaults. They do not authorize live pricing, safety, tax, legal, insurance, or communications policy.'}
              </p>
              <div className="setup-policy-list">
                <div>
                  <span className="setup-policy-icon">
                    <CircleDollarSign size={18} />
                  </span>
                  <span>
                    <strong>Pricing guardrails</strong>
                    <small>$225 minimum · 42% margin floor · discounts above 10% need owner</small>
                  </span>
                  <Badge tone="warning">Legal/tax review</Badge>
                </div>
                <div>
                  <span className="setup-policy-icon">
                    <MessageSquareText size={18} />
                  </span>
                  <span>
                    <strong>Communications</strong>
                    <small>
                      Transactional consent required · bulk and negative replies need owner
                    </small>
                  </span>
                  <Badge tone="positive">Conservative</Badge>
                </div>
                <div>
                  <span className="setup-policy-icon">
                    <ShieldCheck size={18} />
                  </span>
                  <span>
                    <strong>Safety boundary</strong>
                    <small>
                      No invented chemical instructions · incidents freeze affected automation
                    </small>
                  </span>
                  <Badge tone="warning">Safety review</Badge>
                </div>
                <div>
                  <span className="setup-policy-icon">
                    <MapPinned size={18} />
                  </span>
                  <span>
                    <strong>DFW starter zone</strong>
                    <small>
                      20-mile core · $35 extended · $75 outer · route verified before booking
                    </small>
                  </span>
                  <Badge tone="info">Editable draft</Badge>
                </div>
              </div>
              <label className="setup-acknowledgement">
                <input
                  type="checkbox"
                  checked={policyAcknowledged}
                  onChange={(event) => {
                    setPolicyAcknowledged(event.target.checked);
                    setValidationError(undefined);
                  }}
                />
                <span>
                  {state.dataMode === 'supabase'
                    ? 'I understand this creates an owner-scoped setup workspace with inactive services, unpublished drafts, disabled providers, and every marked launch review still required.'
                    : 'I understand these settings are local sandbox guardrails and that every marked launch review remains required before live use.'}
                </span>
              </label>
            </>
          )}

          {step === 3 && (
            <>
              <div className="setup-complete-icon">
                <ShieldCheck size={28} />
              </div>
              <h1>
                {state.dataMode === 'supabase'
                  ? 'Confirm the protected setup scope.'
                  : 'Confirm the local sandbox scope.'}
              </h1>
              <p className="setup-description">
                {state.dataMode === 'supabase'
                  ? `On confirmation, ${businessName.trim()} will receive one owner membership, ${services.length} inactive service draft${services.length === 1 ? '' : 's'}, review-required pricing/terms/retention records, and no live optional providers. Private field-media Storage and its trusted finalizer remain required whenever authenticated Supabase mode is used. Nothing below exists until the server confirms it.`
                  : `On confirmation, ${businessName.trim()} will store ${services.length} selected sandbox service${services.length === 1 ? '' : 's'} locally and open the explicitly synthetic workflow fixtures. Nothing below is a live provider or customer record.`}
              </p>
              <div className="setup-launch-grid">
                <div>
                  <strong>{state.dataMode === 'supabase' ? services.length : 10}</strong>
                  <span>
                    {state.dataMode === 'supabase'
                      ? 'inactive services to create'
                      : 'sandbox adapters available'}
                  </span>
                </div>
                <div>
                  <strong>{state.dataMode === 'supabase' ? 10 : 8}</strong>
                  <span>
                    {state.dataMode === 'supabase'
                      ? 'providers to keep disabled'
                      : 'guarded agent fixtures'}
                  </span>
                </div>
                <div>
                  <strong>{state.dataMode === 'supabase' ? 3 : 4}</strong>
                  <span>
                    {state.dataMode === 'supabase'
                      ? 'review-required drafts to create'
                      : 'sandbox role views'}
                  </span>
                </div>
                <div>
                  <strong>0</strong>
                  <span>
                    {state.dataMode === 'supabase'
                      ? 'prices this action will publish'
                      : 'keys required'}
                  </span>
                </div>
              </div>
              <div className="setup-final-note">
                <ShieldCheck size={17} />
                {state.dataMode === 'supabase'
                  ? 'After durable confirmation, company status will remain setup. Activate services and publish reviewed pricing, terms, policy, and providers only through the documented launch controls.'
                  : 'Confirmation writes only the local sandbox profile. Live provider mode remains disabled until server credentials, callback validation, contract tests, owner activation, and the launch checklist are complete.'}
              </div>
            </>
          )}

          {validationError && (
            <p className="setup-error" role="alert">
              {validationError}
            </p>
          )}

          <div className="setup-actions">
            <Button
              variant="secondary"
              disabled={step === 0 || submitting}
              onClick={() => setStep((current) => Math.max(0, current - 1))}
              icon={<ChevronLeft size={15} />}
            >
              Back
            </Button>
            <Button
              disabled={submitting}
              onClick={() => void next()}
              icon={<ArrowRight size={15} />}
            >
              {submitting
                ? 'Confirming…'
                : step === steps.length - 1
                  ? state.dataMode === 'supabase'
                    ? 'Create setup workspace'
                    : 'Create sandbox profile'
                  : 'Continue'}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
