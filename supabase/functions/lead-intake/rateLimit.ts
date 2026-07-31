import { sha256TextHex } from '../../../src/core/integrations/webhooks.ts';
import { HttpError } from '../_shared/http.ts';
import type { NormalizedLeadIntake } from '../../../src/core/intake/index.ts';

const DEFAULT_COMPANY_RATE_LIMIT_PER_MINUTE = 120;
const DEFAULT_CONTACT_RATE_LIMIT_PER_HOUR = 30;

type RpcClient = {
  rpc(
    functionName: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

function configuredLimit(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new HttpError(`Server configuration ${name} is invalid.`, 503, 'MISCONFIGURED');
  }
  return parsed;
}

async function consumeBudget(
  client: RpcClient,
  parameters: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await client.rpc('consume_operation_budget', parameters);
  if (error) throw new Error(`Lead-intake durable budget failed: ${error.message}`);
  const row = (data as Array<{ allowed?: unknown }> | null)?.[0];
  if (!row || typeof row.allowed !== 'boolean') {
    throw new Error('Lead-intake durable budget returned an invalid result.');
  }
  return row.allowed;
}

export async function enforceLeadIntakeRateLimits(
  client: RpcClient,
  event: NormalizedLeadIntake,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const companyLimit = configuredLimit(
    environment,
    'LEAD_INTAKE_COMPANY_RATE_LIMIT_PER_MINUTE',
    DEFAULT_COMPANY_RATE_LIMIT_PER_MINUTE,
    2_000,
  );
  const companyAllowed = await consumeBudget(client, {
    p_company_id: event.companyId,
    p_scope: 'edge:lead-intake:company',
    p_subject_hash: await sha256TextHex(`lead-intake:company:${event.companyId}:${event.provider}`),
    p_limit: companyLimit,
    p_window_seconds: 60,
    p_units: 1,
  });
  if (!companyAllowed) {
    throw new HttpError('Lead intake rate limit exceeded.', 429, 'RATE_LIMITED');
  }

  const contactLimit = configuredLimit(
    environment,
    'LEAD_INTAKE_CONTACT_RATE_LIMIT_PER_HOUR',
    DEFAULT_CONTACT_RATE_LIMIT_PER_HOUR,
    500,
  );
  const contactAllowed = await consumeBudget(client, {
    p_company_id: event.companyId,
    p_scope: 'edge:lead-intake:contact',
    p_subject_hash: await sha256TextHex(
      `lead-intake:contact:${event.companyId}:${event.communication.sender}`,
    ),
    p_limit: contactLimit,
    p_window_seconds: 3_600,
    p_units: 1,
  });
  if (!contactAllowed) {
    throw new HttpError('Contact intake rate limit exceeded.', 429, 'RATE_LIMITED');
  }
}
