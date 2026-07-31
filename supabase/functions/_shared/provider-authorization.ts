import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from './http.ts';
import { storyopsDeploymentFingerprint } from './deployment-fingerprint.ts';

export type ProviderInvocationClass = 'internal' | 'launch_start' | 'recovery';

type RpcError = Readonly<{ message?: string }>;

function authorizationError(operation: string, error: RpcError | null): HttpError {
  const message = error?.message ?? '';
  const code = message.match(/[A-Z][A-Z0-9_]{4,120}/u)?.[0];
  return new HttpError(
    `${operation} is blocked by authoritative provider or launch controls.`,
    503,
    code ?? 'PROVIDER_AUTHORIZATION_UNAVAILABLE',
  );
}

export async function assertProviderInvocation(
  client: SupabaseClient,
  input: {
    companyId: string;
    provider: string;
    capability: string;
    operationClass: ProviderInvocationClass;
  },
): Promise<string> {
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceRoleKey) {
    throw new HttpError(
      'Live provider invocation is missing its deployment fingerprint key.',
      503,
      'PROVIDER_DEPLOYMENT_FINGERPRINT_UNAVAILABLE',
    );
  }
  const deploymentFingerprint = await storyopsDeploymentFingerprint(
    Deno.env.toObject(),
    serviceRoleKey,
  );
  const { data, error } = await client.rpc('assert_storyops_provider_invocation', {
    p_company_id: input.companyId,
    p_provider: input.provider,
    p_capability: input.capability,
    p_operation_class: input.operationClass,
    p_deployment_fingerprint: deploymentFingerprint,
  });
  if (
    error ||
    !data ||
    typeof data !== 'object' ||
    (data as { authorized?: unknown }).authorized !== true
  ) {
    throw authorizationError('Live provider invocation', error);
  }
  return deploymentFingerprint;
}

export async function assertLaunchStart(
  client: SupabaseClient,
  input: {
    companyId: string;
    capability:
      'inbound_lead_intake' | 'customer_contact' | 'payment_collection' | 'live_scheduling';
  },
): Promise<void> {
  const { data, error } = await client.rpc('assert_storyops_launch_start', {
    p_company_id: input.companyId,
    p_capability: input.capability,
  });
  if (
    error ||
    !data ||
    typeof data !== 'object' ||
    (data as { authorized?: unknown }).authorized !== true
  ) {
    throw authorizationError('Controlled launch start', error);
  }
}
