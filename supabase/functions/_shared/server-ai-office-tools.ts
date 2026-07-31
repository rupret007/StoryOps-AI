import type { SupabaseClient } from '@supabase/supabase-js';
import type { OfficeToolName } from '../../../src/core/ai/contracts.ts';
import { OfficeToolRegistry, ToolExecutionError } from '../../../src/core/ai/tools.ts';
import { approvedRefundPayloadSchema } from '../ai-approved-action/contracts.ts';
import { registerServerPricingTool } from './server-pricing-tool.ts';
import { registerServerRecordTools } from './server-record-tools.ts';

export const serverAiOfficeToolNames = [
  'pricing.calculate',
  'records.read',
  'records.create_lead',
  'records.update_lead',
  'metrics.read',
  'payments.refund',
] as const satisfies readonly OfficeToolName[];

export type ServerAiOfficeToolDependencies = {
  readClient: SupabaseClient;
  commandClient: SupabaseClient;
  now?: () => Date;
};

/**
 * Build the complete production AI Office registry.
 *
 * Provider reads and writes deliberately do not enter this registry. Read-side
 * truth comes from tenant-scoped server records and deterministic calculations.
 * The only provider-shaped capability is a metadata-only refund proposal: the
 * orchestrator can create an exact owner approval, but execution is possible
 * only through the dedicated, revalidating ai-approved-action boundary.
 */
export function createServerAiOfficeToolRegistry(
  dependencies: ServerAiOfficeToolDependencies,
): OfficeToolRegistry {
  const registry = new OfficeToolRegistry();
  registerServerPricingTool(registry, dependencies.readClient);
  registerServerRecordTools(registry, {
    readClient: dependencies.readClient,
    commandClient: dependencies.commandClient,
    now: dependencies.now,
  });
  registry.register({
    name: 'payments.refund',
    description:
      'Propose an exact refund for owner approval. This registry never contacts Stripe; the dedicated approved-action executor revalidates company-owned payment facts before any provider call.',
    input: approvedRefundPayloadSchema,
    risk: 'high',
    sideEffect: 'external_write',
    reversible: false,
    supportsIdempotency: true,
    autoExecute: false,
    execute: () =>
      Promise.reject(
        new ToolExecutionError(
          'Refund execution is restricted to the dedicated approved-action boundary.',
          {
            retryable: false,
            providerCode: 'APPROVED_ACTION_EXECUTOR_REQUIRED',
          },
        ),
      ),
  });
  return registry;
}
