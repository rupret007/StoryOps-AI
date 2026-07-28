import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { assessIntegrationEnvironment } from '../../../src/core/integrations/configuration.ts';
import {
  IntegrationHealthService,
  listSuiteIntegrations,
} from '../../../src/core/integrations/health.ts';
import { createServerIntegrationSuite } from '../../../src/core/integrations/liveServer.ts';
import {
  consumeOperationBudget,
  positiveIntegerSetting,
} from '../../../src/core/integrations/operationBudget.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

const requestSchema = z.object({
  companyId: z.string().uuid(),
});

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  try {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
    }
    const client = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const {
      data: { user },
      error: authError,
    } = await client.auth.getUser(authorization.slice('Bearer '.length));
    if (authError || !user) {
      throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
    }
    const rawBody = await readTextBody(request, 10_000);
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = requestSchema.safeParse(json);
    if (!parsed.success) {
      throw new HttpError('A valid companyId is required.', 400, 'INVALID_REQUEST');
    }
    const { data: membership, error: membershipError } = await client
      .from('company_memberships')
      .select('role')
      .eq('company_id', parsed.data.companyId)
      .eq('user_id', user.id)
      .eq('active', true)
      .maybeSingle();
    if (membershipError || !membership) {
      throw new HttpError('Company membership is required.', 403, 'FORBIDDEN');
    }
    if (!['owner', 'dispatcher'].includes(membership.role)) {
      throw new HttpError(
        'Only owners and dispatchers may run active integration probes.',
        403,
        'FORBIDDEN',
      );
    }
    const healthBudget = await consumeOperationBudget({
      client,
      companyId: parsed.data.companyId,
      scope: 'integration_health:user:hour',
      subject: user.id,
      limit: positiveIntegerSetting(
        Deno.env.get('INTEGRATION_HEALTH_RATE_LIMIT_PER_HOUR'),
        12,
        'INTEGRATION_HEALTH_RATE_LIMIT_PER_HOUR',
      ),
      windowSeconds: 3_600,
    });
    if (!healthBudget.allowed) {
      throw new HttpError(
        `Integration health probe limit reached; retry after ${healthBudget.reset_at}.`,
        429,
        'RATE_LIMITED',
      );
    }

    const environment = Deno.env.toObject();
    const configured = assessIntegrationEnvironment(environment);
    let providers = configured;
    if (!configured.some((provider) => provider.status === 'not_configured')) {
      const suite = createServerIntegrationSuite(environment);
      providers = (await new IntegrationHealthService(listSuiteIntegrations(suite)).checkAll())
        .providers;
    }
    const rank = { healthy: 0, not_configured: 1, degraded: 2, down: 3 };
    const overall = providers.reduce(
      (current, provider) => (rank[provider.status] > rank[current] ? provider.status : current),
      'healthy' as keyof typeof rank,
    );
    return jsonResponse({
      overall,
      checkedAt: new Date().toISOString(),
      providers,
    });
  } catch (error) {
    return errorResponse(error);
  }
});
