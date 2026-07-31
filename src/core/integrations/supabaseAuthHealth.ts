import type { HealthCheckedIntegration, IntegrationHealth, IntegrationMode } from './contracts.ts';
import { createIntegrationProbeEvidence } from './probeEvidence.ts';

type EnvironmentReader = Readonly<Record<string, string | undefined>>;

const requiredEnvironment = [
  'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
  'STORYOPS_IDENTITY_INVITE_MODE',
  'STORYOPS_IDENTITY_INVITE_REDIRECT_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

function requiredSetting(environment: EnvironmentReader, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Supabase Auth identity probe requires ${name}.`);
  return value;
}

function trustedUrl(raw: string, purpose: 'supabase' | 'redirect'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Supabase Auth ${purpose} URL is invalid.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`Supabase Auth ${purpose} URL must use HTTPS outside loopback.`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`Supabase Auth ${purpose} URL contains unsupported authority data.`);
  }
  return url;
}

export class SupabaseAuthIdentityInvitationHealth implements HealthCheckedIntegration {
  readonly provider = 'supabase_auth';
  readonly capability = 'identity_invitation';
  readonly mode: IntegrationMode = 'live';

  constructor(private readonly environment: EnvironmentReader) {}

  async health(signal?: AbortSignal): Promise<IntegrationHealth> {
    const checkedAt = new Date().toISOString();
    const startedAt = performance.now();
    const serviceRoleKey = requiredSetting(this.environment, 'SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = trustedUrl(requiredSetting(this.environment, 'SUPABASE_URL'), 'supabase');
    trustedUrl(
      requiredSetting(this.environment, 'STORYOPS_IDENTITY_INVITE_REDIRECT_URL'),
      'redirect',
    );
    const endpoint = new URL(
      `${supabaseUrl.toString().replace(/\/$/u, '')}/auth/v1/admin/users?page=1&per_page=1`,
    );
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
      },
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Supabase Auth admin directory read was not accepted.');
    }
    const responseText = await response.text();
    if (responseText.length > 1_000_000) {
      throw new Error('Supabase Auth admin directory probe exceeded its response limit.');
    }
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      throw new Error('Supabase Auth admin directory returned invalid JSON.');
    }
    if (
      responseBody === null ||
      typeof responseBody !== 'object' ||
      Array.isArray(responseBody) ||
      !Array.isArray((responseBody as { users?: unknown }).users)
    ) {
      throw new Error('Supabase Auth admin directory returned an unsupported response.');
    }
    return {
      provider: this.provider,
      capability: this.capability,
      mode: this.mode,
      status: 'healthy',
      checkedAt,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      message:
        'Supabase Auth admin directory external read is healthy; no invitation was submitted.',
      requiredEnvironment: [...requiredEnvironment],
      probeEvidence: await createIntegrationProbeEvidence(
        'external_read',
        'supabase_auth.admin_directory.retrieve',
        {
          status: response.status,
          directoryShapeVerified: true,
          mutationAttempted: false,
        },
      ),
    };
  }
}
