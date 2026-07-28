import {
  Bot,
  CalendarDays,
  CheckCircle2,
  CloudSun,
  Database,
  FileSpreadsheet,
  HardDriveUpload,
  HeartPulse,
  Mail,
  MapPinned,
  MessageSquareText,
  RefreshCcw,
  Route,
  Settings2,
  WalletCards,
} from 'lucide-react';
import { useStoryOps } from '@/state/StoryOpsProvider';
import { Badge, Button, Card, PageHeader } from '@/components/ui/Primitives';

const integrationIcons = {
  openai: Bot,
  twilio: MessageSquareText,
  email: Mail,
  stripe: WalletCards,
  calendar: CalendarDays,
  google_calendar: CalendarDays,
  maps: MapPinned,
  nws: CloudSun,
  vroom: Route,
  signed_storage_targets: HardDriveUpload,
  supabase_signed_storage_targets: HardDriveUpload,
  quickbooks: FileSpreadsheet,
  quickbooks_export: FileSpreadsheet,
};

export function IntegrationsPage() {
  const { state, actions, can } = useStoryOps();
  const healthy = state.integrations.filter(
    (integration) => integration.status === 'Healthy',
  ).length;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Provider health"
        title={
          state.dataMode === 'supabase'
            ? 'Authenticated provider health'
            : 'Start in sandbox; activate real providers intentionally'
        }
        description="Optional provider adapters report mode, capability, last check, and configuration gaps. Core authenticated data-plane readiness is shown separately."
        actions={
          <Button
            variant="secondary"
            disabled={!can('integrations.manage')}
            onClick={actions.checkIntegrations}
            icon={<RefreshCcw size={15} />}
          >
            Check all providers
          </Button>
        }
      />

      <Card className="integration-health-banner">
        <span className="integration-health-banner__icon">
          <HeartPulse size={22} />
        </span>
        <div>
          <h2>
            {healthy} of {state.integrations.length} optional provider checks healthy
          </h2>
          <p>
            {state.dataMode === 'supabase'
              ? 'Run check all providers to invoke the authenticated, secret-safe Edge health boundary. These cards do not certify the required private field-media data plane.'
              : 'StoryOps is fully operational in sandbox mode. No live messages, charges, calendar events, Storage uploads, or route requests leave this environment.'}
          </p>
        </div>
        <Badge tone={state.dataMode === 'supabase' ? 'positive' : 'accent'} dot>
          {state.dataMode === 'supabase' ? 'Live workspace' : 'Sandbox safe'}
        </Badge>
      </Card>

      <Card className="integration-health-banner">
        <span className="integration-health-banner__icon">
          <HardDriveUpload size={22} />
        </span>
        <div>
          <h2>Core field-media data plane</h2>
          <p>
            {state.dataMode === 'supabase'
              ? 'Required in authenticated mode: private job-media Storage RLS, immutable content-addressed uploads, byte read-back, and the field-media-finalize Edge boundary. Any upload, checksum, or finalizer failure blocks registration and completion.'
              : 'Local-only in sandbox mode: field evidence stays in the sandbox/IndexedDB workflow and makes zero Supabase Storage requests.'}
          </p>
        </div>
        <Badge tone={state.dataMode === 'supabase' ? 'warning' : 'info'} dot>
          {state.dataMode === 'supabase' ? 'Required · verify' : 'No network'}
        </Badge>
      </Card>

      <section className="integration-grid" aria-label="Integration health">
        {state.integrations.map((integration) => {
          const Icon =
            integrationIcons[integration.id as keyof typeof integrationIcons] ?? Settings2;
          return (
            <Card className="integration-card" key={integration.id}>
              <div className="integration-card__top">
                <span className="integration-card__icon">
                  <Icon size={18} />
                </span>
                <div>
                  <p className="integration-card__name">{integration.name}</p>
                  <p className="integration-card__provider">{integration.provider}</p>
                </div>
                <Badge tone={integration.mode === 'Sandbox' ? 'info' : 'positive'}>
                  {integration.mode}
                </Badge>
              </div>
              <ul className="capability-list">
                {integration.capabilities.map((capability) => (
                  <li key={capability}>
                    <CheckCircle2 size={12} /> {capability}
                  </li>
                ))}
              </ul>
              <div className="integration-card__health">
                <span>
                  <i className="health-dot" /> {integration.status}
                </span>
                <span>Checked {integration.lastCheck}</span>
              </div>
            </Card>
          );
        })}
      </section>

      <div className="integration-bottom-grid">
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Webhook boundary</h2>
              <p className="section-card__subtitle">Inbound events fail closed</p>
            </div>
            <Database size={18} color="#1f6d5e" />
          </div>
          <ul className="guardrail-list">
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Signature before parse</strong>
                <small>Raw body, timestamp tolerance, constant-time comparison</small>
              </span>
            </li>
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Unique provider event ID</strong>
                <small>Duplicate events return the prior durable result</small>
              </span>
            </li>
            <li>
              <CheckCircle2 size={14} />
              <span>
                <strong>Retrieve canonical state</strong>
                <small>Payment and delivery truth is verified with the provider</small>
              </span>
            </li>
          </ul>
        </Card>
        <Card className="section-card">
          <div className="section-card__header">
            <div>
              <h2>Activation checklist</h2>
              <p className="section-card__subtitle">Per provider, before live mode</p>
            </div>
            <Settings2 size={18} color="#1f6d5e" />
          </div>
          <ol className="activation-list">
            <li>
              <span>1</span> Add server-side credentials to the deployment secret store
            </li>
            <li>
              <span>2</span> Register and verify callback/webhook URLs
            </li>
            <li>
              <span>3</span> Run provider-specific sandbox contract tests
            </li>
            <li>
              <span>4</span> Confirm consent, rate-limit, retry, and incident ownership
            </li>
            <li>
              <span>5</span> Owner enables live mode after health check
            </li>
          </ol>
        </Card>
      </div>
    </div>
  );
}
