import {
  ArrowLeft,
  BadgeCheck,
  BriefcaseBusiness,
  Building2,
  CalendarClock,
  CircleDollarSign,
  Gauge,
  Plus,
  PlugZap,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  UsersRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  assessCompanyConfiguration,
  createServiceCompanyConfiguration,
  type CompanyConfiguration,
  type CompanyConfigurationSection,
} from '@/domain/companyConfiguration';
import {
  getCanonicalPricingConfiguration,
  getIndustryPackRuntimeForCode,
  getIndustryPackRuntimeForInput,
  listIndustryPackCodes,
  type IndustryPackRuntimeProfile,
} from '@/data/industryPackRuntime';
import type { ServiceIndustryPackCode } from '@/data/industryPacks';
import { getIndustryPackServiceRequirements } from '@/domain/industryPackRequirements';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { useNavigate } from '@/router';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, Field, Progress } from '@/components/ui/Primitives';
import { MaterialSdsRegistrationPanel } from '@/components/MaterialSdsRegistrationPanel';
import { reviewedSdsPdfChecksum } from '@/core/materials/sdsRegistry';
import { prepareSandboxRehearsalConfiguration } from '@/core/pilot/sandboxConfiguration';

type StudioTab = 'company' | 'territory' | 'operations' | 'money' | 'engagement' | 'publication';

const tabs: Array<[StudioTab, string, LucideIcon]> = [
  ['company', 'Company', Building2],
  ['territory', 'Area & hours', CalendarClock],
  ['operations', 'People & resources', Wrench],
  ['money', 'Pricing & policy', CircleDollarSign],
  ['engagement', 'Growth & providers', PlugZap],
  ['publication', 'Review & publish', ShieldCheck],
];

const sectionLabels: Record<CompanyConfigurationSection, string> = {
  identity: 'Identity',
  territory: 'Territory',
  schedule: 'Schedule',
  pricing: 'Pricing',
  people: 'People',
  resources: 'Resources',
  materials: 'Materials/SDS',
  payments: 'Payments',
  policies: 'Policies',
  engagement: 'Engagement',
  integrations: 'Integrations',
};

interface BootstrapFields {
  legalName: string;
  displayName: string;
  ownerName: string;
  publicEmail: string;
  publicPhone: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  packCode: ServiceIndustryPackCode;
  enabledServiceCodes: string[];
}

function canGenerateCanonicalPackageTiers(
  runtime: IndustryPackRuntimeProfile,
  enabledServiceCodes: readonly string[],
): boolean {
  try {
    runtime.buildPackages(enabledServiceCodes);
    return true;
  } catch {
    return false;
  }
}

function canDisableConfiguredService(
  runtime: IndustryPackRuntimeProfile,
  enabledServiceCodes: readonly string[],
  serviceCode: string,
): boolean {
  const remainingServiceCodes = runtime.serviceTemplates
    .map((template) => template.catalogItem.code)
    .filter((code) => code !== serviceCode && enabledServiceCodes.includes(code));
  return canGenerateCanonicalPackageTiers(runtime, remainingServiceCodes);
}

function initialBootstrap(
  dataMode: 'sandbox' | 'supabase',
  profile: ReturnType<typeof useStoryOps>['state']['setupProfile'],
  liveCompanyName?: string,
): BootstrapFields {
  const sandbox = dataMode === 'sandbox';
  const legalName = profile?.businessName ?? liveCompanyName ?? '';
  const profileRuntime = profile?.enabledServiceCodes
    ? getIndustryPackRuntimeForInput({ enabledServiceCodes: profile.enabledServiceCodes })
    : undefined;
  const runtime = profileRuntime ?? getIndustryPackRuntimeForCode('exterior-services');
  if (!runtime) throw new Error('The default exterior-services industry pack is unavailable.');
  return {
    legalName,
    displayName: legalName,
    ownerName: profile?.ownerName ?? '',
    publicEmail: sandbox ? 'owner@story-exterior.example' : '',
    publicPhone: sandbox ? '+18175550100' : '',
    addressLine1: sandbox ? '100 Sandbox Service Road' : '',
    city: sandbox ? 'Grapevine' : '',
    region: 'TX',
    postalCode: profile?.homePostalCode ?? (sandbox ? '76051' : ''),
    packCode: runtime.packCode,
    enabledServiceCodes:
      profileRuntime && profile
        ? [...profile.enabledServiceCodes]
        : [...runtime.defaultEnabledServiceCodes],
  };
}

export function CompanyConfigurationStudio() {
  const { state, actions } = useStoryOps();
  const navigate = useNavigate();
  const [tab, setTab] = useState<StudioTab>('company');
  const [draft, setDraft] = useState<CompanyConfiguration | undefined>(
    state.companyConfiguration?.draft,
  );
  const [bootstrap, setBootstrap] = useState<BootstrapFields>(() =>
    initialBootstrap(state.dataMode, state.setupProfile, state.live?.companyName),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [reviewReference, setReviewReference] = useState(
    state.dataMode === 'sandbox' ? 'sandbox-owner-review-v1' : '',
  );

  const publicationMode = state.dataMode === 'supabase' ? 'live' : 'sandbox';
  const readiness = useMemo(
    () => (draft ? assessCompanyConfiguration(draft, publicationMode) : undefined),
    [draft, publicationMode],
  );

  const updateDraft = (mutate: (next: CompanyConfiguration) => void) => {
    setError(undefined);
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
  };

  const generateDraft = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const runtime = getIndustryPackRuntimeForCode(bootstrap.packCode);
      if (!runtime) throw new Error('Select a supported industry pack before creating the draft.');
      const generated = createServiceCompanyConfiguration({
        legalName: bootstrap.legalName,
        displayName: bootstrap.displayName,
        ownerName: bootstrap.ownerName,
        publicEmail: bootstrap.publicEmail,
        publicPhone: bootstrap.publicPhone,
        addressLine1: bootstrap.addressLine1,
        city: bootstrap.city,
        region: bootstrap.region,
        postalCode: bootstrap.postalCode,
        enabledServiceCodes: bootstrap.enabledServiceCodes,
        priceBookTemplateVersion: runtime.packVersion,
        starterEquipmentType: runtime.starterEquipmentType,
        starterSkills: runtime.starterSkills,
        ...getCanonicalPricingConfiguration(runtime, bootstrap.enabledServiceCodes),
      });
      const configuration =
        state.dataMode === 'sandbox' ? prepareSandboxRehearsalConfiguration(generated) : generated;
      const receipt = await actions.saveCompanyConfigurationDraft(configuration);
      if (!receipt) {
        setError('The configuration draft was not confirmed. No saved revision is being claimed.');
        return;
      }
      setDraft(configuration);
      setTab('operations');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Configuration draft is invalid.');
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await actions.saveCompanyConfigurationDraft(draft);
      if (!receipt) {
        setError('The configuration draft was not confirmed. No saved revision is being claimed.');
      }
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await actions.publishCompanyConfiguration({
        publicationMode,
        reviewReference,
      });
      if (!receipt) {
        setError('Publication was not confirmed. The current draft remains unpublished.');
      }
    } finally {
      setBusy(false);
    }
  };

  const publishOperatingBaseline = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await actions.publishOperatingBaseline({ reviewReference });
      if (!receipt) {
        setError(
          'Operating-baseline publication was not confirmed. Existing prices, terms, providers, and company state are unchanged.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="configuration-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="configuration-header">
        <div className="portal-brand">
          <span className="brand__mark">
            <Sparkles size={17} />
          </span>
          WashOps
        </div>
        <div className="configuration-header__actions">
          <Badge tone={state.dataMode === 'supabase' ? 'warning' : 'info'}>
            {state.dataMode === 'supabase' ? 'Authenticated workspace' : 'Local sandbox'}
          </Badge>
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowLeft size={15} />}
            onClick={() => navigate('/')}
          >
            Command center
          </Button>
        </div>
      </header>

      <main className="configuration-main" id="main-content">
        <div className="configuration-title">
          <div>
            <p className="eyebrow">Owner configuration studio</p>
            <h1>Configure the company without changing source code.</h1>
            <p>
              Draft every operating section, inspect deterministic readiness, then publish an exact
              snapshot. Configuration publication never activates a provider or authorizes company
              launch.
            </p>
          </div>
          {state.companyConfiguration && (
            <div className="configuration-revision">
              <Badge
                tone={state.companyConfiguration.status === 'published' ? 'positive' : 'warning'}
                dot
              >
                {state.companyConfiguration.status.replaceAll('_', ' ')}
              </Badge>
              <strong>Revision {state.companyConfiguration.revision}</strong>
              <small>
                {state.companyConfiguration.publicationMode
                  ? `${state.companyConfiguration.publicationMode} snapshot`
                  : 'not published'}
              </small>
            </div>
          )}
        </div>

        {!draft ? (
          <BootstrapConfiguration
            fields={bootstrap}
            setFields={setBootstrap}
            busy={busy}
            error={error}
            onGenerate={() => void generateDraft()}
            live={state.dataMode === 'supabase'}
          />
        ) : (
          <div className="configuration-layout">
            <Card className="configuration-nav">
              {tabs.map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  aria-current={tab === id ? 'page' : undefined}
                  onClick={() => setTab(id)}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              ))}
              {readiness && (
                <div className="configuration-nav__score">
                  <span>Snapshot completeness</span>
                  <strong>{readiness.score}%</strong>
                  <Progress
                    value={readiness.score}
                    label="Company configuration readiness"
                    tone={readiness.publishable ? 'green' : 'orange'}
                  />
                </div>
              )}
            </Card>

            <div className="configuration-workspace">
              {tab === 'company' && <CompanyPanel draft={draft} update={updateDraft} />}
              {tab === 'territory' && <TerritoryPanel draft={draft} update={updateDraft} />}
              {tab === 'operations' && (
                <>
                  <OperationsPanel draft={draft} update={updateDraft} />
                  <MaterialSdsRegistrationPanel />
                </>
              )}
              {tab === 'money' && <MoneyPanel draft={draft} update={updateDraft} />}
              {tab === 'engagement' && <EngagementPanel draft={draft} update={updateDraft} />}
              {tab === 'publication' && readiness && (
                <PublicationPanel
                  readiness={readiness}
                  publicationMode={publicationMode}
                  reviewReference={reviewReference}
                  onReviewReference={setReviewReference}
                  onPublish={() => void publish()}
                  onPublishOperatingBaseline={() => void publishOperatingBaseline()}
                  busy={busy}
                  published={state.companyConfiguration?.status === 'published'}
                  activeBaselineRevision={state.operatingBaseline?.configurationRevision}
                  configurationRevision={state.companyConfiguration?.revision}
                />
              )}

              {error && (
                <p className="setup-error" role="alert">
                  {error}
                </p>
              )}
              {tab !== 'publication' && (
                <div className="configuration-savebar">
                  <span>
                    Saving creates a new reviewed draft revision. It changes no published snapshot.
                  </span>
                  <Button icon={<Save size={15} />} loading={busy} onClick={() => void saveDraft()}>
                    Save draft revision
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function BootstrapConfiguration({
  fields,
  setFields,
  busy,
  error,
  onGenerate,
  live,
}: {
  fields: BootstrapFields;
  setFields: (next: BootstrapFields) => void;
  busy: boolean;
  error?: string;
  onGenerate(): void;
  live: boolean;
}) {
  const update = <Key extends keyof BootstrapFields>(key: Key, value: BootstrapFields[Key]) =>
    setFields({ ...fields, [key]: value });
  const runtime = getIndustryPackRuntimeForCode(fields.packCode);
  if (!runtime) throw new Error(`Industry pack ${fields.packCode} is unavailable.`);
  const toggleService = (code: string) => {
    const currentlyEnabled = fields.enabledServiceCodes.includes(code);
    if (currentlyEnabled && !canDisableConfiguredService(runtime, fields.enabledServiceCodes, code))
      return;
    update(
      'enabledServiceCodes',
      currentlyEnabled
        ? fields.enabledServiceCodes.filter((item) => item !== code)
        : [...fields.enabledServiceCodes, code],
    );
  };

  return (
    <Card className="configuration-bootstrap">
      <div className="section-card__header">
        <div>
          <h2>Create the complete owner draft</h2>
          <p className="section-card__subtitle">
            {live
              ? 'No contact, address, resource, or inspection value is prefilled in live mode.'
              : 'Synthetic contact, address, owner-skill, and equipment-inspection fixtures are visibly reserved for local rehearsal.'}
          </p>
        </div>
        <BriefcaseBusiness size={20} color="#1f6d5e" />
      </div>
      <div className="configuration-section">
        <h3>Identity and service address</h3>
        <div className="input-group">
          <TextField
            id="config-legal-name"
            label="Legal business name"
            value={fields.legalName}
            onChange={(value) => update('legalName', value)}
          />
          <TextField
            id="config-display-name"
            label="Customer-facing name"
            value={fields.displayName}
            onChange={(value) => update('displayName', value)}
          />
          <TextField
            id="config-owner-name"
            label="Owner name"
            value={fields.ownerName}
            onChange={(value) => update('ownerName', value)}
          />
          <TextField
            id="config-email"
            label="Public email"
            value={fields.publicEmail}
            type="email"
            onChange={(value) => update('publicEmail', value)}
          />
          <TextField
            id="config-phone"
            label="Public phone (E.164)"
            value={fields.publicPhone}
            hint="Example: +18175551234"
            onChange={(value) => update('publicPhone', value)}
          />
          <TextField
            id="config-address"
            label="Service-base street"
            value={fields.addressLine1}
            onChange={(value) => update('addressLine1', value)}
          />
          <TextField
            id="config-city"
            label="City"
            value={fields.city}
            onChange={(value) => update('city', value)}
          />
          <TextField
            id="config-region"
            label="State"
            value={fields.region}
            onChange={(value) => update('region', value.toUpperCase())}
          />
          <TextField
            id="config-postal"
            label="ZIP code"
            value={fields.postalCode}
            onChange={(value) => update('postalCode', value)}
          />
        </div>
      </div>
      <div className="configuration-section">
        <Field label="Industry pack" htmlFor="configuration-industry-pack">
          <select
            id="configuration-industry-pack"
            className="select"
            value={fields.packCode}
            onChange={(event) => {
              const nextRuntime = getIndustryPackRuntimeForCode(event.target.value);
              if (!nextRuntime) return;
              setFields({
                ...fields,
                packCode: nextRuntime.packCode,
                enabledServiceCodes: [...nextRuntime.defaultEnabledServiceCodes],
              });
            }}
          >
            {listIndustryPackCodes().map((packCode) => {
              const optionRuntime = getIndustryPackRuntimeForCode(packCode);
              return optionRuntime ? (
                <option key={packCode} value={packCode}>
                  {optionRuntime.packName}
                </option>
              ) : null;
            })}
          </select>
        </Field>
        <h3>{runtime.packName} industry pack</h3>
        <p>
          These selections constrain quoting and booking. Disabled deterministic templates remain
          installed so a later reviewed revision can enable them without source or database changes.
        </p>
        <div className="configuration-service-grid">
          {runtime.serviceTemplates.map((template) => (
            <label key={template.catalogItem.code}>
              <input
                type="checkbox"
                checked={fields.enabledServiceCodes.includes(template.catalogItem.code)}
                disabled={
                  fields.enabledServiceCodes.includes(template.catalogItem.code) &&
                  !canDisableConfiguredService(
                    runtime,
                    fields.enabledServiceCodes,
                    template.catalogItem.code,
                  )
                }
                onChange={() => toggleService(template.catalogItem.code)}
              />
              <span>
                <strong>{template.catalogItem.name}</strong>
                <small>{template.scope.primaryMeasurementKind.replaceAll('_', ' ')}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="setup-final-note">
          Keep a service set that supports the pack's deterministic Good, Better, and Best package
          policy. Unsupported combinations remain blocked instead of generating partial packages.
        </p>
      </div>
      <div className="setup-final-note">
        <ShieldCheck size={17} />
        {live
          ? 'This first save is a review-only draft. Equipment remains due and qualifications remain unverified until the owner records exact evidence in the editor.'
          : 'This first save creates a review-only draft with explicitly synthetic skills and current-inspection fixtures. They can support only the local rehearsal and prove no real qualification, inspection, or readiness.'}
      </div>
      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}
      <div className="configuration-savebar">
        <span>
          Starter tax, terms, retention, safety, and provider records remain review-required.
        </span>
        <Button loading={busy} icon={<Save size={15} />} onClick={onGenerate}>
          Create review draft
        </Button>
      </div>
    </Card>
  );
}

export function CompanyPanel({
  draft,
  update,
}: {
  draft: CompanyConfiguration;
  update(mutate: (draft: CompanyConfiguration) => void): void;
}) {
  return (
    <Panel
      title="Company identity and brand"
      description="These values appear in customer-facing records after the relevant templates are published."
      icon={<Building2 size={20} />}
    >
      <div className="input-group">
        <TextField
          id="identity-legal"
          label="Legal name"
          value={draft.identity.legalName}
          onChange={(value) => update((next) => void (next.identity.legalName = value))}
        />
        <TextField
          id="identity-display"
          label="Display name"
          value={draft.identity.displayName}
          onChange={(value) => update((next) => void (next.identity.displayName = value))}
        />
        <TextField
          id="identity-owner"
          label="Owner name"
          value={draft.identity.ownerName}
          onChange={(value) => update((next) => void (next.identity.ownerName = value))}
        />
        <TextField
          id="identity-email"
          label="Public email"
          type="email"
          value={draft.identity.publicEmail}
          onChange={(value) => update((next) => void (next.identity.publicEmail = value))}
        />
        <TextField
          id="identity-phone"
          label="Public phone"
          value={draft.identity.publicPhone}
          onChange={(value) => update((next) => void (next.identity.publicPhone = value))}
        />
        <TextField
          id="identity-website"
          label="Website (optional HTTPS)"
          value={draft.identity.website}
          onChange={(value) => update((next) => void (next.identity.website = value))}
        />
        <TextField
          id="identity-logo"
          label="Logo URL (optional HTTPS)"
          value={draft.identity.brand.logoUrl}
          onChange={(value) => update((next) => void (next.identity.brand.logoUrl = value))}
        />
        <TextField
          id="identity-primary"
          label="Primary color"
          value={draft.identity.brand.primaryColor}
          onChange={(value) => update((next) => void (next.identity.brand.primaryColor = value))}
        />
        <TextField
          id="identity-accent"
          label="Accent color"
          value={draft.identity.brand.accentColor}
          onChange={(value) => update((next) => void (next.identity.brand.accentColor = value))}
        />
      </div>
    </Panel>
  );
}

function TerritoryPanel({
  draft,
  update,
}: {
  draft: CompanyConfiguration;
  update(mutate: (draft: CompanyConfiguration) => void): void;
}) {
  const runtime = getIndustryPackRuntimeForInput({
    enabledServiceCodes: draft.pricing.enabledServiceCodes,
    priceBookTemplateVersion: draft.pricing.priceBookTemplateVersion,
  });
  return (
    <div className="configuration-stack">
      <Panel
        title="Service base and travel zones"
        description="Quotes use only exact, owner-reviewed ZIP mappings. Unmapped addresses stop for review; mileage labels never infer a fee."
        icon={<Gauge size={20} />}
      >
        <div className="input-group">
          <TextField
            id="territory-line1"
            label="Street"
            value={draft.territory.serviceAddress.line1}
            onChange={(value) =>
              update((next) => void (next.territory.serviceAddress.line1 = value))
            }
          />
          <TextField
            id="territory-city"
            label="City"
            value={draft.territory.serviceAddress.city}
            onChange={(value) =>
              update((next) => void (next.territory.serviceAddress.city = value))
            }
          />
          <TextField
            id="territory-region"
            label="State"
            value={draft.territory.serviceAddress.region}
            onChange={(value) =>
              update((next) => void (next.territory.serviceAddress.region = value.toUpperCase()))
            }
          />
          <TextField
            id="territory-postal"
            label="ZIP code"
            value={draft.territory.serviceAddress.postalCode}
            onChange={(value) =>
              update((next) => void (next.territory.serviceAddress.postalCode = value))
            }
          />
          <TextField
            id="territory-timezone"
            label="Timezone"
            value={draft.territory.timezone}
            onChange={(value) => update((next) => void (next.territory.timezone = value))}
          />
          <TextField
            id="territory-note"
            label="Service-area definition"
            value={draft.territory.serviceAreaNote}
            onChange={(value) => update((next) => void (next.territory.serviceAreaNote = value))}
          />
        </div>
        <div className="configuration-zone-grid">
          {draft.territory.travelZones.map((zone, index) => (
            <Card className="configuration-zone" key={zone.code}>
              <div className="configuration-card-heading">
                <strong>{zone.code}</strong>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  disabled={draft.territory.travelZones.length === 1}
                  onClick={() =>
                    update((next) => {
                      next.territory.travelZones.splice(index, 1);
                    })
                  }
                >
                  Remove
                </Button>
              </div>
              <TextField
                id={`zone-${index}-code`}
                label="Zone code"
                value={zone.code}
                onChange={(value) =>
                  update(
                    (next) => void (next.territory.travelZones[index]!.code = value.toUpperCase()),
                  )
                }
              />
              <TextField
                id={`zone-${index}-name`}
                label="Name"
                value={zone.name}
                onChange={(value) =>
                  update((next) => void (next.territory.travelZones[index]!.name = value))
                }
              />
              <TextField
                id={`zone-${index}-miles`}
                label="Reference maximum miles (optional)"
                value={zone.maximumMiles}
                inputMode="decimal"
                onChange={(value) =>
                  update((next) => void (next.territory.travelZones[index]!.maximumMiles = value))
                }
              />
              <TextField
                id={`zone-${index}-fee`}
                label="Travel fee"
                value={zone.fee}
                inputMode="decimal"
                onChange={(value) =>
                  update((next) => void (next.territory.travelZones[index]!.fee = value))
                }
              />
              <TextField
                id={`zone-${index}-postal-codes`}
                label="Exact five-digit ZIP mappings (comma separated)"
                value={zone.postalCodes.join(', ')}
                onChange={(value) =>
                  update(
                    (next) =>
                      void (next.territory.travelZones[index]!.postalCodes = value
                        .split(',')
                        .map((postalCode) => postalCode.trim())
                        .filter(Boolean)),
                  )
                }
              />
            </Card>
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={draft.territory.travelZones.length >= 12}
          onClick={() =>
            update((next) => {
              const sequence = next.territory.travelZones.length + 1;
              next.territory.travelZones.push({
                code: `ZONE-${sequence}`,
                name: `Service zone ${sequence}`,
                maximumMiles: '',
                fee: '0.00',
                postalCodes: [],
              });
            })
          }
        >
          Add travel zone
        </Button>
        <Card className="configuration-review">
          <strong>Travel-zone mapping review</strong>
          <p>
            Record who checked these exact ZIP-to-fee mappings and where that review is documented.
            Live publication remains blocked until this evidence is approved.
          </p>
          <Field label="Status" htmlFor="travel-zone-review-status">
            <select
              id="travel-zone-review-status"
              className="select"
              value={draft.territory.travelZoneMappingReview.status}
              onChange={(event) =>
                update(
                  (next) =>
                    void (next.territory.travelZoneMappingReview.status = event.target
                      .value as typeof next.territory.travelZoneMappingReview.status),
                )
              }
            >
              <option value="required">Required</option>
              <option value="in_review">In review</option>
              <option value="approved">Approved</option>
            </select>
          </Field>
          <TextField
            id="travel-zone-reviewer"
            label="Mapping reviewer"
            value={draft.territory.travelZoneMappingReview.reviewer}
            onChange={(value) =>
              update((next) => void (next.territory.travelZoneMappingReview.reviewer = value))
            }
          />
          <TextField
            id="travel-zone-review-evidence"
            label="Evidence reference"
            value={draft.territory.travelZoneMappingReview.evidenceReference}
            onChange={(value) =>
              update(
                (next) => void (next.territory.travelZoneMappingReview.evidenceReference = value),
              )
            }
          />
          <TextField
            id="travel-zone-reviewed-at"
            label="Reviewed at (ISO 8601)"
            value={draft.territory.travelZoneMappingReview.reviewedAt}
            onChange={(value) =>
              update((next) => void (next.territory.travelZoneMappingReview.reviewedAt = value))
            }
          />
        </Card>
        <div className="configuration-price-rules">
          {draft.pricing.serviceRules.map((rule, ruleIndex) => (
            <details key={rule.serviceCode}>
              <summary>
                <span>
                  <strong>
                    {runtime?.serviceTemplates.find(
                      (template) => template.catalogItem.code === rule.serviceCode,
                    )?.catalogItem.name ?? rule.serviceCode}
                  </strong>
                  <small>
                    {rule.pricingUnit} · {rule.attributeMultipliers.length} multipliers ·{' '}
                    {rule.addOns.length} add-ons
                  </small>
                </span>
                <Badge tone="neutral">Deterministic</Badge>
              </summary>
              <div className="input-group">
                {(
                  [
                    ['basePrice', 'Base price'],
                    ['unitPrice', 'Unit price'],
                    ['includedQuantity', 'Included quantity'],
                    ['serviceMinimum', 'Service minimum'],
                    ['estimatedBaseCost', 'Estimated base cost'],
                    ['estimatedUnitCost', 'Estimated unit cost'],
                    ['durationMinutesPerUnit', 'Minutes per unit'],
                  ] as const
                ).map(([key, label]) => (
                  <TextField
                    id={`rule-${rule.serviceCode}-${key}`}
                    key={key}
                    label={label}
                    inputMode="decimal"
                    value={rule[key]}
                    onChange={(value) =>
                      update((next) => void (next.pricing.serviceRules[ruleIndex]![key] = value))
                    }
                  />
                ))}
                <NumberField
                  id={`rule-${rule.serviceCode}-duration-base`}
                  label="Base duration (minutes)"
                  value={rule.durationBaseMinutes}
                  onChange={(value) =>
                    update(
                      (next) =>
                        void (next.pricing.serviceRules[ruleIndex]!.durationBaseMinutes = value),
                    )
                  }
                />
              </div>
              {rule.attributeMultipliers.length > 0 && (
                <div className="configuration-multiplier-grid">
                  {rule.attributeMultipliers.map((multiplier, multiplierIndex) => (
                    <TextField
                      id={`rule-${rule.serviceCode}-multiplier-${multiplier.attribute}-${multiplier.value}`}
                      key={`${multiplier.attribute}:${multiplier.value}`}
                      label={`${multiplier.attribute.replaceAll('_', ' ')} · ${multiplier.value}`}
                      inputMode="decimal"
                      value={multiplier.multiplier}
                      onChange={(value) =>
                        update(
                          (next) =>
                            void (next.pricing.serviceRules[ruleIndex]!.attributeMultipliers[
                              multiplierIndex
                            ]!.multiplier = value),
                        )
                      }
                    />
                  ))}
                </div>
              )}
              {rule.addOns.length > 0 && (
                <div className="configuration-add-on-list">
                  {rule.addOns.map((addOn, addOnIndex) => (
                    <div key={addOn.code}>
                      <span>
                        <strong>{addOn.name}</strong>
                        <small>
                          {addOn.code} · {addOn.pricingUnit}
                        </small>
                      </span>
                      <TextField
                        id={`rule-${rule.serviceCode}-addon-${addOn.code}-price`}
                        label="Unit price"
                        inputMode="decimal"
                        value={addOn.unitPrice}
                        onChange={(value) =>
                          update(
                            (next) =>
                              void (next.pricing.serviceRules[ruleIndex]!.addOns[
                                addOnIndex
                              ]!.unitPrice = value),
                          )
                        }
                      />
                      <TextField
                        id={`rule-${rule.serviceCode}-addon-${addOn.code}-cost`}
                        label="Unit cost"
                        inputMode="decimal"
                        value={addOn.estimatedUnitCost}
                        onChange={(value) =>
                          update(
                            (next) =>
                              void (next.pricing.serviceRules[ruleIndex]!.addOns[
                                addOnIndex
                              ]!.estimatedUnitCost = value),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </details>
          ))}
        </div>
        <div className="configuration-package-grid">
          {draft.pricing.packages.map((servicePackage) => (
            <Card className="configuration-package" key={servicePackage.code}>
              <Badge
                tone={
                  servicePackage.tier === 'best'
                    ? 'accent'
                    : servicePackage.tier === 'better'
                      ? 'info'
                      : 'neutral'
                }
              >
                {servicePackage.tier}
              </Badge>
              <strong>{servicePackage.name}</strong>
              <p>{servicePackage.description}</p>
              <small>
                {servicePackage.components.filter((component) => component.required).length}{' '}
                required ·{' '}
                {servicePackage.components.filter((component) => !component.required).length}{' '}
                optional service
              </small>
            </Card>
          ))}
        </div>
      </Panel>
      <Panel
        title="Capacity boundaries"
        description="Business hours and buffers are deterministic scheduling inputs, not availability promises."
        icon={<CalendarClock size={20} />}
      >
        <div className="configuration-hours">
          {draft.schedule.businessHours.map((entry, index) => (
            <div key={entry.day}>
              <strong>{entry.day}</strong>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={!entry.closed}
                  onChange={(event) =>
                    update(
                      (next) =>
                        void (next.schedule.businessHours[index]!.closed = !event.target.checked),
                    )
                  }
                />
                Open
              </label>
              <input
                className="input"
                aria-label={`${entry.day} opens`}
                type="time"
                value={entry.opensAt}
                disabled={entry.closed}
                onChange={(event) =>
                  update(
                    (next) =>
                      void (next.schedule.businessHours[index]!.opensAt = event.target.value),
                  )
                }
              />
              <input
                className="input"
                aria-label={`${entry.day} closes`}
                type="time"
                value={entry.closesAt}
                disabled={entry.closed}
                onChange={(event) =>
                  update(
                    (next) =>
                      void (next.schedule.businessHours[index]!.closesAt = event.target.value),
                  )
                }
              />
            </div>
          ))}
        </div>
        <div className="input-group">
          <NumberField
            id="schedule-buffer"
            label="Appointment buffer (minutes)"
            value={draft.schedule.appointmentBufferMinutes}
            onChange={(value) =>
              update((next) => void (next.schedule.appointmentBufferMinutes = value))
            }
          />
          <NumberField
            id="schedule-lead"
            label="Minimum lead time (hours)"
            value={draft.schedule.minimumLeadTimeHours}
            onChange={(value) =>
              update((next) => void (next.schedule.minimumLeadTimeHours = value))
            }
          />
          <NumberField
            id="schedule-window"
            label="Maximum booking window (days)"
            value={draft.schedule.maximumBookingDays}
            onChange={(value) => update((next) => void (next.schedule.maximumBookingDays = value))}
          />
        </div>
      </Panel>
    </div>
  );
}

export function OperationsPanel({
  draft,
  update,
}: {
  draft: CompanyConfiguration;
  update(mutate: (draft: CompanyConfiguration) => void): void;
}) {
  const [materialPdfStatus, setMaterialPdfStatus] = useState<Record<string, string>>({});
  const nextIdentifier = (prefix: string, identifiers: readonly string[]) => {
    const used = new Set(identifiers);
    let sequence = identifiers.length + 1;
    while (used.has(`${prefix}-${sequence}`)) sequence += 1;
    return `${prefix}-${sequence}`;
  };
  const requirements = getIndustryPackServiceRequirements(
    draft.pricing.enabledServiceCodes,
    undefined,
    draft.pricing.priceBookTemplateVersion,
  );
  const activeOwner = draft.people.crewMembers.find(
    (member) => member.active && member.role === 'owner',
  );
  const ownerSkills = new Set(activeOwner?.skills ?? []);
  const missingOwnerSkills = requirements.requiredSkills.filter((skill) => !ownerSkills.has(skill));
  const missingEquipmentTypes = requirements.requiredEquipmentTypes.filter(
    (equipmentType) =>
      !draft.resources.equipment.some(
        (equipment) =>
          equipment.active &&
          equipment.inspectionStatus === 'current' &&
          equipment.equipmentType === equipmentType,
      ),
  );

  return (
    <div className="configuration-stack">
      <Panel
        title="Crew and permissions"
        description="Single-owner V1 requires exactly one active owner. Dispatcher and technician rows are planning records only until a separate authenticated onboarding workflow creates their membership."
        icon={<UsersRound size={20} />}
      >
        <div className="setup-final-note" role="status">
          <ShieldCheck size={17} />
          <span>
            <strong>Owner qualification gate.</strong>{' '}
            {missingOwnerSkills.length === 0
              ? 'The active owner records every skill required by the selected services.'
              : `Still missing from the active owner: ${missingOwnerSkills.join(', ')}.`}{' '}
            Planning personnel cannot satisfy this gate.
          </span>
        </div>
        <div className="configuration-resource-grid">
          {draft.people.crewMembers.map((crew, index) => (
            <Card className="configuration-resource" key={crew.id}>
              <div className="configuration-card-heading">
                <span>
                  <strong>{crew.name}</strong>
                  <small>
                    {crew.id} ·{' '}
                    {crew.role === 'owner' && crew.active
                      ? 'operational owner'
                      : 'planning record only'}
                  </small>
                </span>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  disabled={draft.people.crewMembers.length === 1}
                  aria-label={`Remove crew member ${crew.name}`}
                  onClick={() =>
                    update((next) => {
                      next.people.crewMembers.splice(index, 1);
                    })
                  }
                >
                  Remove
                </Button>
              </div>
              <TextField
                id={`crew-${index}-name`}
                label="Crew member name"
                value={crew.name}
                onChange={(value) =>
                  update((next) => void (next.people.crewMembers[index]!.name = value))
                }
              />
              <Field label="Role" htmlFor={`crew-${index}-role`}>
                <select
                  id={`crew-${index}-role`}
                  className="select"
                  value={crew.role}
                  onChange={(event) =>
                    update(
                      (next) =>
                        void (next.people.crewMembers[index]!.role = event.target
                          .value as typeof crew.role),
                    )
                  }
                >
                  <option value="owner">Owner</option>
                  <option value="dispatcher">Dispatcher</option>
                  <option value="technician">Technician</option>
                </select>
              </Field>
              <TextField
                id={`crew-${index}-skills`}
                label="Skills (comma separated)"
                value={crew.skills.join(', ')}
                onChange={(value) =>
                  update(
                    (next) =>
                      void (next.people.crewMembers[index]!.skills = [
                        ...new Set(
                          value
                            .split(',')
                            .map((item) =>
                              item
                                .trim()
                                .toLowerCase()
                                .replaceAll(/[^a-z0-9-]+/gu, '-'),
                            )
                            .filter(Boolean),
                        ),
                      ]),
                  )
                }
              />
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={crew.active}
                  onChange={(event) =>
                    update(
                      (next) =>
                        void (next.people.crewMembers[index]!.active = event.target.checked),
                    )
                  }
                />
                Active crew member
              </label>
            </Card>
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={draft.people.crewMembers.length >= 50}
          onClick={() =>
            update((next) => {
              const id = nextIdentifier(
                'crew',
                next.people.crewMembers.map((member) => member.id),
              );
              next.people.crewMembers.push({
                id,
                name: `Crew member ${next.people.crewMembers.length + 1}`,
                role: 'technician',
                skills: [],
                active: true,
              });
            })
          }
        >
          Add crew member
        </Button>
      </Panel>
      <Panel
        title="Vehicles"
        description="Dispatch must find active capacity and current inspection evidence."
        icon={<Wrench size={20} />}
      >
        <div className="configuration-resource-grid">
          {draft.resources.vehicles.map((vehicle, index) => (
            <Card className="configuration-resource" key={vehicle.id}>
              <div className="configuration-card-heading">
                <span>
                  <strong>{vehicle.name}</strong>
                  <small>{vehicle.id}</small>
                </span>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  disabled={draft.resources.vehicles.length === 1}
                  aria-label={`Remove vehicle ${vehicle.name}`}
                  onClick={() =>
                    update((next) => {
                      next.resources.vehicles.splice(index, 1);
                    })
                  }
                >
                  Remove
                </Button>
              </div>
              <TextField
                id={`vehicle-${index}-name`}
                label="Vehicle name"
                value={vehicle.name}
                onChange={(value) =>
                  update((next) => void (next.resources.vehicles[index]!.name = value))
                }
              />
              <Field label="Vehicle kind" htmlFor={`vehicle-${index}-kind`}>
                <select
                  id={`vehicle-${index}-kind`}
                  className="select"
                  value={vehicle.kind}
                  onChange={(event) =>
                    update(
                      (next) =>
                        void (next.resources.vehicles[index]!.kind = event.target
                          .value as typeof vehicle.kind),
                    )
                  }
                >
                  <option value="truck">Truck</option>
                  <option value="van">Van</option>
                  <option value="trailer">Trailer</option>
                  <option value="other">Other</option>
                </select>
              </Field>
              <TextField
                id={`vehicle-${index}-capacity`}
                label="Capacity note"
                value={vehicle.capacityNote}
                onChange={(value) =>
                  update((next) => void (next.resources.vehicles[index]!.capacityNote = value))
                }
              />
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={vehicle.active}
                  onChange={(event) =>
                    update(
                      (next) =>
                        void (next.resources.vehicles[index]!.active = event.target.checked),
                    )
                  }
                />
                Active vehicle
              </label>
            </Card>
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={draft.resources.vehicles.length >= 50}
          onClick={() =>
            update((next) => {
              const id = nextIdentifier(
                'vehicle',
                next.resources.vehicles.map((vehicle) => vehicle.id),
              );
              next.resources.vehicles.push({
                id,
                name: `Service vehicle ${next.resources.vehicles.length + 1}`,
                kind: 'truck',
                capacityNote: 'Owner confirmation required before dispatch.',
                active: true,
              });
            })
          }
        >
          Add vehicle
        </Button>
      </Panel>
      <Panel
        title="Equipment"
        description="Quantity, type, active status, and current inspection evidence constrain dispatch."
        icon={<Wrench size={20} />}
      >
        <div className="setup-final-note" role="status">
          <ShieldCheck size={17} />
          <span>
            <strong>Selected-service equipment gate.</strong>{' '}
            {missingEquipmentTypes.length === 0
              ? 'Every required equipment type has an active current inspection.'
              : `Still missing current owner evidence for: ${missingEquipmentTypes.join(', ')}.`}
          </span>
        </div>
        <div className="configuration-resource-grid">
          {draft.resources.equipment.map((equipment, index) => (
            <Card className="configuration-resource" key={equipment.id}>
              <div className="configuration-card-heading">
                <span>
                  <strong>{equipment.name}</strong>
                  <small>{equipment.id}</small>
                </span>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  disabled={draft.resources.equipment.length === 1}
                  aria-label={`Remove equipment ${equipment.name}`}
                  onClick={() =>
                    update((next) => {
                      next.resources.equipment.splice(index, 1);
                    })
                  }
                >
                  Remove
                </Button>
              </div>
              <TextField
                id={`equipment-${index}-name`}
                label="Equipment name"
                value={equipment.name}
                onChange={(value) =>
                  update((next) => void (next.resources.equipment[index]!.name = value))
                }
              />
              <TextField
                id={`equipment-${index}-type`}
                label="Equipment type"
                value={equipment.equipmentType}
                onChange={(value) =>
                  update(
                    (next) =>
                      void (next.resources.equipment[index]!.equipmentType = value
                        .trim()
                        .toLowerCase()
                        .replaceAll(/[^a-z0-9-]+/gu, '-')),
                  )
                }
              />
              <NumberField
                id={`equipment-${index}-quantity`}
                label="Quantity"
                value={equipment.quantity}
                onChange={(value) =>
                  update((next) => void (next.resources.equipment[index]!.quantity = value))
                }
              />
              <Field label="Inspection status" htmlFor={`equipment-${index}-inspection`}>
                <select
                  id={`equipment-${index}-inspection`}
                  className="select"
                  value={equipment.inspectionStatus}
                  onChange={(event) =>
                    update(
                      (next) =>
                        void (next.resources.equipment[index]!.inspectionStatus = event.target
                          .value as typeof equipment.inspectionStatus),
                    )
                  }
                >
                  <option value="current">Current</option>
                  <option value="due">Due</option>
                  <option value="out_of_service">Out of service</option>
                </select>
              </Field>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={equipment.active}
                  onChange={(event) =>
                    update(
                      (next) =>
                        void (next.resources.equipment[index]!.active = event.target.checked),
                    )
                  }
                />
                Active equipment
              </label>
            </Card>
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={draft.resources.equipment.length >= 100}
          onClick={() =>
            update((next) => {
              const id = nextIdentifier(
                'equipment',
                next.resources.equipment.map((equipment) => equipment.id),
              );
              next.resources.equipment.push({
                id,
                name: `Equipment ${next.resources.equipment.length + 1}`,
                equipmentType: 'other-equipment',
                quantity: 1,
                inspectionStatus: 'due',
                active: true,
              });
            })
          }
        >
          Add equipment
        </Button>
      </Panel>
      <Panel
        title="Materials and SDS gate"
        description="WashOps stores references and checksums, never invented chemical instructions."
        icon={<ShieldCheck size={20} />}
      >
        <div className="configuration-resource-grid">
          {draft.materials.catalog.map((material, index) => (
            <Card className="configuration-resource" key={material.id}>
              <div className="configuration-card-heading">
                <span>
                  <strong>{material.name}</strong>
                  <small>{material.id}</small>
                </span>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  disabled={draft.materials.catalog.length === 1}
                  aria-label={`Remove material ${material.name}`}
                  onClick={() =>
                    update((next) => {
                      next.materials.catalog.splice(index, 1);
                    })
                  }
                >
                  Remove
                </Button>
              </div>
              <TextField
                id={`material-${index}-name`}
                label="Material name"
                value={material.name}
                onChange={(value) =>
                  update((next) => void (next.materials.catalog[index]!.name = value))
                }
              />
              <TextField
                id={`material-${index}-unit`}
                label="Unit"
                value={material.unit}
                onChange={(value) =>
                  update((next) => void (next.materials.catalog[index]!.unit = value))
                }
              />
              <Field label="SDS status" htmlFor={`material-${index}-sds-status`}>
                <select
                  id={`material-${index}-sds-status`}
                  className="select"
                  value={material.sdsStatus}
                  disabled={!material.requiresSds}
                  onChange={(event) =>
                    update(
                      (next) =>
                        void (next.materials.catalog[index]!.sdsStatus = event.target
                          .value as typeof material.sdsStatus),
                    )
                  }
                >
                  <option value="not_required">Not required</option>
                  <option value="missing">Missing</option>
                  <option value="in_review">In review</option>
                  <option value="approved">Approved</option>
                </select>
              </Field>
              <TextField
                id={`material-${index}-sds-url`}
                label="Manufacturer source URL (reference only)"
                value={material.sdsReference}
                onChange={(value) =>
                  update((next) => void (next.materials.catalog[index]!.sdsReference = value))
                }
              />
              <TextField
                id={`material-${index}-sds-hash`}
                label="SDS SHA-256"
                value={material.sdsChecksumSha256}
                onChange={(value) =>
                  update(
                    (next) =>
                      void (next.materials.catalog[index]!.sdsChecksumSha256 = value.toLowerCase()),
                  )
                }
              />
              {material.requiresSds && (
                <Field
                  label="Calculate checksum from reviewed PDF"
                  hint={
                    materialPdfStatus[material.id] ??
                    'PDF only, up to 10 MB. Selecting a different file resets SDS status to in review; save the draft before private registration.'
                  }
                  htmlFor={`material-${index}-reviewed-pdf`}
                >
                  <input
                    id={`material-${index}-reviewed-pdf`}
                    className="input"
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(event) => {
                      const reviewedFile = event.target.files?.[0];
                      if (!reviewedFile) return;
                      setMaterialPdfStatus((current) => ({
                        ...current,
                        [material.id]: 'Calculating SHA-256 from the selected PDF…',
                      }));
                      void reviewedSdsPdfChecksum(reviewedFile)
                        .then((checksum) => {
                          update((next) => {
                            const target = next.materials.catalog[index]!;
                            target.sdsChecksumSha256 = checksum;
                            target.sdsStatus = 'in_review';
                          });
                          setMaterialPdfStatus((current) => ({
                            ...current,
                            [material.id]: `Expected SHA-256 calculated: ${checksum}. Complete owner review, set status to approved, then save this exact revision.`,
                          }));
                        })
                        .catch((caught: unknown) => {
                          setMaterialPdfStatus((current) => ({
                            ...current,
                            [material.id]:
                              caught instanceof Error
                                ? caught.message
                                : 'The selected file could not be validated.',
                          }));
                        });
                    }}
                  />
                </Field>
              )}
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={material.requiresSds}
                  onChange={(event) =>
                    update((next) => {
                      const target = next.materials.catalog[index]!;
                      target.requiresSds = event.target.checked;
                      target.sdsStatus = event.target.checked ? 'missing' : 'not_required';
                      if (!event.target.checked) {
                        target.sdsReference = '';
                        target.sdsChecksumSha256 = '';
                      }
                    })
                  }
                />
                Chemical material requires SDS
              </label>
            </Card>
          ))}
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<Plus size={14} />}
          disabled={draft.materials.catalog.length >= 100}
          onClick={() =>
            update((next) => {
              const id = nextIdentifier(
                'material',
                next.materials.catalog.map((material) => material.id),
              );
              next.materials.catalog.push({
                id,
                name: `Material ${next.materials.catalog.length + 1}`,
                unit: 'unit',
                requiresSds: false,
                sdsStatus: 'not_required',
                sdsReference: '',
                sdsChecksumSha256: '',
              });
            })
          }
        >
          Add material
        </Button>
      </Panel>
    </div>
  );
}

export function MoneyPanel({
  draft,
  update,
}: {
  draft: CompanyConfiguration;
  update(mutate: (draft: CompanyConfiguration) => void): void;
}) {
  const runtime = getIndustryPackRuntimeForInput({
    enabledServiceCodes: draft.pricing.enabledServiceCodes,
    priceBookTemplateVersion: draft.pricing.priceBookTemplateVersion,
  });
  const [packageImpact, setPackageImpact] = useState(
    runtime?.packCode === 'exterior-services'
      ? 'Changing the enabled service set regenerates all three canonical package scopes atomically. Keep at least three services, or two including gutter cleaning with the explicit measured Best downspout flush.'
      : 'Changing the enabled service set regenerates all three canonical package scopes atomically.',
  );
  const toggleConfiguredService = (serviceCode: string, serviceName: string) => {
    if (!runtime) return;
    const currentlyEnabled = draft.pricing.enabledServiceCodes.includes(serviceCode);
    if (
      currentlyEnabled &&
      !canDisableConfiguredService(runtime, draft.pricing.enabledServiceCodes, serviceCode)
    )
      return;
    const nextEnabledServiceCodes = currentlyEnabled
      ? draft.pricing.enabledServiceCodes.filter((code) => code !== serviceCode)
      : [...draft.pricing.enabledServiceCodes, serviceCode];
    const supportedEnabledServiceCodes = runtime.serviceTemplates
      .map((template) => template.catalogItem.code)
      .filter((code) => nextEnabledServiceCodes.includes(code));
    update((next) => {
      next.pricing.enabledServiceCodes = supportedEnabledServiceCodes;
      next.pricing.packages = runtime.buildPackages(supportedEnabledServiceCodes);
    });
    setPackageImpact(
      `${serviceName} ${currentlyEnabled ? 'disabled' : 'enabled'}. Good, Better, and Best were regenerated from the canonical package policy for ${runtime.packName}.`,
    );
  };

  return (
    <div className="configuration-stack">
      <Panel
        title="Deterministic price-book controls"
        description="All money and percentages remain decimal strings and are evaluated by the pricing engine."
        icon={<CircleDollarSign size={20} />}
      >
        <div className="input-group">
          <TextField
            id="pricing-minimum"
            label="Company minimum"
            inputMode="decimal"
            value={draft.pricing.companyMinimum}
            onChange={(value) => update((next) => void (next.pricing.companyMinimum = value))}
          />
          <TextField
            id="pricing-margin"
            label="Margin floor (%)"
            inputMode="decimal"
            value={draft.pricing.marginFloorPercent}
            onChange={(value) => update((next) => void (next.pricing.marginFloorPercent = value))}
          />
          <TextField
            id="pricing-discount"
            label="Automatic discount limit (%)"
            inputMode="decimal"
            value={draft.pricing.automaticDiscountLimitPercent}
            onChange={(value) =>
              update((next) => void (next.pricing.automaticDiscountLimitPercent = value))
            }
          />
          <TextField
            id="pricing-tax"
            label="Default tax rate (%)"
            inputMode="decimal"
            value={draft.pricing.defaultTaxRatePercent}
            onChange={(value) =>
              update((next) => void (next.pricing.defaultTaxRatePercent = value))
            }
          />
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.pricing.taxEnabled}
              onChange={(event) =>
                update((next) => void (next.pricing.taxEnabled = event.target.checked))
              }
            />
            Apply configured tax to taxable line items
          </label>
          <Field label="Tax review status" htmlFor="pricing-tax-review">
            <select
              id="pricing-tax-review"
              className="select"
              value={draft.pricing.taxReview.status}
              onChange={(event) =>
                update(
                  (next) =>
                    void (next.pricing.taxReview.status = event.target
                      .value as typeof next.pricing.taxReview.status),
                )
              }
            >
              <option value="required">Required</option>
              <option value="in_review">In review</option>
              <option value="approved">Approved</option>
            </select>
          </Field>
          <TextField
            id="pricing-tax-reviewer"
            label="Tax reviewer"
            value={draft.pricing.taxReview.reviewer}
            onChange={(value) => update((next) => void (next.pricing.taxReview.reviewer = value))}
          />
          <TextField
            id="pricing-tax-evidence"
            label="Tax review evidence"
            value={draft.pricing.taxReview.evidenceReference}
            onChange={(value) =>
              update((next) => void (next.pricing.taxReview.evidenceReference = value))
            }
          />
          <TextField
            id="pricing-tax-reviewed-at"
            label="Tax reviewed at (ISO 8601)"
            value={draft.pricing.taxReview.reviewedAt}
            onChange={(value) => update((next) => void (next.pricing.taxReview.reviewedAt = value))}
          />
        </div>
        <div className="configuration-service-grid">
          {runtime?.serviceTemplates.map((template) => (
            <label key={template.catalogItem.code}>
              <input
                type="checkbox"
                checked={draft.pricing.enabledServiceCodes.includes(template.catalogItem.code)}
                disabled={
                  draft.pricing.enabledServiceCodes.includes(template.catalogItem.code) &&
                  !canDisableConfiguredService(
                    runtime,
                    draft.pricing.enabledServiceCodes,
                    template.catalogItem.code,
                  )
                }
                aria-describedby="configuration-package-impact"
                onChange={() =>
                  toggleConfiguredService(template.catalogItem.code, template.catalogItem.name)
                }
              />
              <span>
                <strong>{template.catalogItem.name}</strong>
                <small>{template.priceRule.pricingUnit}</small>
              </span>
            </label>
          ))}
        </div>
        {!runtime && (
          <p className="setup-error" role="alert">
            This draft does not resolve to one complete industry pack. Pricing changes are blocked.
          </p>
        )}
        <p className="setup-final-note" id="configuration-package-impact" role="status">
          {packageImpact}
        </p>
      </Panel>
      <Panel
        title="Payments, cancellation, and retention"
        description="Refunds remain approval-required; provider settlement still requires signed reconciliation."
        icon={<BadgeCheck size={20} />}
      >
        <div className="input-group">
          <Field label="Deposit policy" htmlFor="payment-deposit-kind">
            <select
              id="payment-deposit-kind"
              className="select"
              value={draft.payments.depositKind}
              onChange={(event) =>
                update(
                  (next) =>
                    void (next.payments.depositKind = event.target
                      .value as typeof next.payments.depositKind),
                )
              }
            >
              <option value="none">None</option>
              <option value="percent">Percentage</option>
              <option value="fixed">Fixed amount</option>
            </select>
          </Field>
          <TextField
            id="payment-deposit-value"
            label="Deposit value"
            value={draft.payments.depositValue}
            inputMode="decimal"
            onChange={(value) => update((next) => void (next.payments.depositValue = value))}
          />
          <NumberField
            id="policy-cancellation-hours"
            label="Cancellation notice (hours)"
            value={draft.policies.cancellationHours}
            onChange={(value) => update((next) => void (next.policies.cancellationHours = value))}
          />
          <TextField
            id="policy-cancellation-fee"
            label="Cancellation fee"
            value={draft.policies.cancellationFee}
            inputMode="decimal"
            onChange={(value) => update((next) => void (next.policies.cancellationFee = value))}
          />
          <NumberField
            id="policy-reschedule-hours"
            label="Reschedule notice (hours)"
            value={draft.policies.rescheduleHours}
            onChange={(value) => update((next) => void (next.policies.rescheduleHours = value))}
          />
          <NumberField
            id="policy-ai-retention"
            label="AI trace retention (days)"
            value={draft.policies.retentionDays.aiTraces}
            onChange={(value) =>
              update((next) => void (next.policies.retentionDays.aiTraces = value))
            }
          />
          <NumberField
            id="policy-operational-retention"
            label="Operational retention (days)"
            value={draft.policies.retentionDays.operational}
            onChange={(value) =>
              update((next) => void (next.policies.retentionDays.operational = value))
            }
          />
          <NumberField
            id="policy-communications-retention"
            label="Communication retention (days)"
            value={draft.policies.retentionDays.communications}
            onChange={(value) =>
              update((next) => void (next.policies.retentionDays.communications = value))
            }
          />
          <NumberField
            id="policy-audit-retention"
            label="Audit retention (days)"
            value={draft.policies.retentionDays.audit}
            onChange={(value) => update((next) => void (next.policies.retentionDays.audit = value))}
          />
          <NumberField
            id="policy-safety-retention"
            label="Safety retention (days)"
            value={draft.policies.retentionDays.safety}
            onChange={(value) =>
              update((next) => void (next.policies.retentionDays.safety = value))
            }
          />
        </div>
        <div className="configuration-checks">
          {(['card', 'ach', 'cash', 'check'] as const).map((method) => (
            <label className="check-row" key={method}>
              <input
                type="checkbox"
                checked={draft.payments.acceptedMethods.includes(method)}
                onChange={() =>
                  update((next) => {
                    next.payments.acceptedMethods = next.payments.acceptedMethods.includes(method)
                      ? next.payments.acceptedMethods.filter((item) => item !== method)
                      : [...next.payments.acceptedMethods, method];
                  })
                }
              />
              Accept {method.toUpperCase()}
            </label>
          ))}
        </div>
        <Field label="Service terms draft" htmlFor="policy-terms">
          <textarea
            id="policy-terms"
            className="textarea"
            value={draft.policies.termsText}
            onChange={(event) =>
              update((next) => void (next.policies.termsText = event.target.value))
            }
          />
        </Field>
        <ReviewEvidenceFields draft={draft} update={update} />
      </Panel>
    </div>
  );
}

function ReviewEvidenceFields({
  draft,
  update,
}: {
  draft: CompanyConfiguration;
  update(mutate: (draft: CompanyConfiguration) => void): void;
}) {
  const reviews = [
    ['legalReview', 'Legal/terms'],
    ['privacyReview', 'Privacy/retention'],
    ['safetyReview', 'Safety/SOP'],
    ['insuranceReview', 'Insurance/vehicle'],
    ['environmentalReview', 'Environmental/runoff'],
  ] as const;
  return (
    <div className="configuration-review-grid">
      {reviews.map(([key, label]) => {
        const review = draft.policies[key];
        return (
          <Card className="configuration-review" key={key}>
            <strong>{label}</strong>
            <Field label="Status" htmlFor={`${key}-status`}>
              <select
                id={`${key}-status`}
                className="select"
                value={review.status}
                onChange={(event) =>
                  update(
                    (next) =>
                      void (next.policies[key].status = event.target
                        .value as (typeof next.policies)[typeof key]['status']),
                  )
                }
              >
                <option value="required">Required</option>
                <option value="in_review">In review</option>
                <option value="approved">Approved</option>
              </select>
            </Field>
            <TextField
              id={`${key}-reviewer`}
              label="Qualified reviewer"
              value={review.reviewer}
              onChange={(value) => update((next) => void (next.policies[key].reviewer = value))}
            />
            <TextField
              id={`${key}-evidence`}
              label="Evidence reference"
              value={review.evidenceReference}
              onChange={(value) =>
                update((next) => void (next.policies[key].evidenceReference = value))
              }
            />
            <TextField
              id={`${key}-time`}
              label="Reviewed at (ISO 8601)"
              value={review.reviewedAt}
              onChange={(value) => update((next) => void (next.policies[key].reviewedAt = value))}
            />
          </Card>
        );
      })}
    </div>
  );
}

function EngagementPanel({
  draft,
  update,
}: {
  draft: CompanyConfiguration;
  update(mutate: (draft: CompanyConfiguration) => void): void;
}) {
  return (
    <div className="configuration-stack">
      <Panel
        title="Reviews, referrals, and recurring care"
        description="Campaign delivery remains consent-filtered and approval-gated."
        icon={<Sparkles size={20} />}
      >
        <div className="configuration-checks">
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.engagement.reviewRequestEnabled}
              onChange={(event) =>
                update((next) => void (next.engagement.reviewRequestEnabled = event.target.checked))
              }
            />
            Enable post-service review requests
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.engagement.referralEnabled}
              onChange={(event) =>
                update((next) => void (next.engagement.referralEnabled = event.target.checked))
              }
            />
            Enable referral invitations
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={draft.engagement.recurringMaintenanceEnabled}
              onChange={(event) =>
                update(
                  (next) =>
                    void (next.engagement.recurringMaintenanceEnabled = event.target.checked),
                )
              }
            />
            Offer recurring maintenance
          </label>
        </div>
        <div className="input-group">
          <TextField
            id="engagement-review-url"
            label="Review URL"
            value={draft.engagement.reviewUrl}
            onChange={(value) => update((next) => void (next.engagement.reviewUrl = value))}
          />
          <NumberField
            id="engagement-review-delay"
            label="Review delay (hours)"
            value={draft.engagement.reviewDelayHours}
            onChange={(value) => update((next) => void (next.engagement.reviewDelayHours = value))}
          />
          <TextField
            id="engagement-referral"
            label="Referral reward/no-reward terms"
            value={draft.engagement.referralRewardDescription}
            onChange={(value) =>
              update((next) => void (next.engagement.referralRewardDescription = value))
            }
          />
        </div>
      </Panel>
      <Panel
        title="Provider dual controls"
        description="Requested mode is a draft preference. Environment readiness is read-only evidence; owner enablement cannot bypass it."
        icon={<PlugZap size={20} />}
      >
        <div className="configuration-provider-list">
          {draft.integrations.providers.map((provider, index) => (
            <div key={provider.provider}>
              <span>
                <strong>{provider.provider.replaceAll('_', ' ')}</strong>
                <small>
                  env {provider.environmentEnabled ? 'ready' : 'off'} · owner{' '}
                  {provider.ownerEnabled ? 'on' : 'off'} · {provider.health.replaceAll('_', ' ')}
                </small>
              </span>
              <select
                className="select"
                aria-label={`${provider.provider} requested mode`}
                value={provider.requestedMode}
                onChange={(event) =>
                  update(
                    (next) =>
                      void (next.integrations.providers[index]!.requestedMode = event.target
                        .value as typeof provider.requestedMode),
                  )
                }
              >
                <option value="disabled">Disabled</option>
                <option value="sandbox">Sandbox</option>
                <option value="live">Request live activation</option>
              </select>
              <span className="check-row" role="note">
                Owner activation is read-only in Studio. Use the authoritative Integrations control.
              </span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function PublicationPanel({
  readiness,
  publicationMode,
  reviewReference,
  onReviewReference,
  onPublish,
  onPublishOperatingBaseline,
  busy,
  published,
  activeBaselineRevision,
  configurationRevision,
}: {
  readiness: ReturnType<typeof assessCompanyConfiguration>;
  publicationMode: 'sandbox' | 'live';
  reviewReference: string;
  onReviewReference(value: string): void;
  onPublish(): void;
  onPublishOperatingBaseline(): void;
  busy: boolean;
  published: boolean;
  activeBaselineRevision?: number;
  configurationRevision?: number;
}) {
  const baselineCurrent =
    published &&
    configurationRevision !== undefined &&
    activeBaselineRevision === configurationRevision;
  return (
    <Panel
      title={`${publicationMode === 'live' ? 'Authenticated' : 'Sandbox'} publication gate`}
      description="The exact draft hash, revision, evidence reference, actor, and mode are retained in the receipt."
      icon={<ShieldCheck size={20} />}
    >
      <div className="configuration-readiness">
        <div>
          <strong>{readiness.score}%</strong>
          <span>configuration readiness</span>
          <Progress
            value={readiness.score}
            label="Configuration publication readiness"
            tone={readiness.publishable ? 'green' : 'orange'}
          />
        </div>
        <div className="configuration-section-status">
          {Object.entries(sectionLabels).map(([section, label]) => {
            const blocked = readiness.blockedSections.includes(
              section as CompanyConfigurationSection,
            );
            return (
              <span key={section}>
                <Badge tone={blocked ? 'danger' : 'positive'}>
                  {blocked ? 'Blocked' : 'Ready'}
                </Badge>
                {label}
              </span>
            );
          })}
        </div>
      </div>
      {readiness.issues.length > 0 && (
        <div className="configuration-issues">
          {readiness.issues.map((issue) => (
            <div key={`${issue.section}:${issue.code}:${issue.message}`}>
              <Badge tone={issue.severity === 'blocking' ? 'danger' : 'warning'}>
                {issue.severity}
              </Badge>
              <span>
                <strong>{sectionLabels[issue.section]}</strong>
                <small>{issue.message}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      <Field
        label="Owner/reviewer evidence reference"
        hint="A ticket, signed checklist, document version, or sandbox rehearsal reference."
        htmlFor="configuration-review-reference"
      >
        <input
          id="configuration-review-reference"
          className="input"
          value={reviewReference}
          onChange={(event) => onReviewReference(event.target.value)}
        />
      </Field>
      <div className="setup-final-note">
        <ShieldCheck size={17} />
        {publicationMode === 'live'
          ? 'Authenticated publication requires qualified tax, legal, privacy, safety, SDS, resource, and provider evidence. It still does not publish a price book or terms, enable customer contact, move money, or authorize launch.'
          : 'Sandbox publication freezes local rehearsal inputs only. It cannot authorize a live company, provider, message, appointment, or payment.'}
      </div>
      <div className="configuration-savebar">
        <span>
          {published
            ? 'Editing and saving now creates a new draft over the immutable published snapshot.'
            : 'No snapshot has been published from this draft.'}
        </span>
        <Button
          loading={busy}
          disabled={!readiness.publishable || reviewReference.trim().length < 5}
          icon={<ShieldCheck size={15} />}
          onClick={onPublish}
        >
          Publish {publicationMode === 'live' ? 'authenticated' : 'sandbox'} snapshot
        </Button>
      </div>
      {publicationMode === 'live' && (
        <div className="configuration-activation-gate">
          <div>
            <Badge tone={baselineCurrent ? 'positive' : 'warning'}>
              {baselineCurrent ? 'Operating baseline active' : 'Separate activation required'}
            </Badge>
            <h3>Materialize reviewed operating records</h3>
            <p>
              This second owner action publishes the exact selected catalog, Decimal price book,
              good/better/best packages, terms, retention policy, crew, vehicle, and equipment
              snapshot. It does not enable OpenAI, Twilio, email, Stripe, calendar, maps, weather,
              routing, storage, QuickBooks, customer delivery, or money movement.
            </p>
          </div>
          <Button
            variant="secondary"
            loading={busy}
            disabled={
              !published ||
              baselineCurrent ||
              reviewReference.trim().length < 5 ||
              reviewReference.trim().length > 240
            }
            icon={<ShieldCheck size={15} />}
            onClick={onPublishOperatingBaseline}
          >
            {baselineCurrent ? 'Operating baseline active' : 'Publish operating baseline'}
          </Button>
        </div>
      )}
    </Panel>
  );
}

function Panel({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="configuration-panel">
      <div className="section-card__header">
        <div>
          <h2>{title}</h2>
          <p className="section-card__subtitle">{description}</p>
        </div>
        <span className="configuration-panel__icon">{icon}</span>
      </div>
      {children}
    </Card>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  type = 'text',
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  hint?: string;
  type?: 'text' | 'email';
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode'];
}) {
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        className="input"
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange(value: number): void;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <input
        id={id}
        className="input"
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}
