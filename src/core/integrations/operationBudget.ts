import { sha256Hex } from '../ai/approval.ts';
import { IntegrationError } from './contracts.ts';

type RpcClient = {
  rpc(
    functionName: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

type BudgetResult = {
  allowed: boolean;
  used: number;
  remaining: number;
  reset_at: string;
};

export function positiveIntegerSetting(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new IntegrationError(
      `${name} must be a positive integer.`,
      'configuration',
      'INVALID_RATE_LIMIT',
      false,
    );
  }
  return parsed;
}

export async function consumeOperationBudget(options: {
  client: RpcClient;
  companyId: string;
  scope: string;
  subject: string;
  limit: number;
  windowSeconds: number;
  units?: number;
}): Promise<BudgetResult> {
  const subjectHash = await sha256Hex({ subject: options.subject });
  const { data, error } = await options.client.rpc('consume_operation_budget', {
    p_company_id: options.companyId,
    p_scope: options.scope,
    p_subject_hash: subjectHash,
    p_limit: options.limit,
    p_window_seconds: options.windowSeconds,
    p_units: options.units ?? 1,
  });
  if (error) {
    throw new IntegrationError(
      `Durable operation budget failed: ${error.message}`,
      'rate_limit',
      'BUDGET_UNAVAILABLE',
      true,
    );
  }
  const row = Array.isArray(data) ? data[0] : undefined;
  if (
    !row ||
    typeof row !== 'object' ||
    typeof (row as Record<string, unknown>).allowed !== 'boolean'
  ) {
    throw new IntegrationError(
      'Durable operation budget returned an invalid response.',
      'rate_limit',
      'BUDGET_UNAVAILABLE',
      true,
    );
  }
  const record = row as Record<string, unknown>;
  return {
    allowed: record.allowed as boolean,
    used: Number(record.used),
    remaining: Number(record.remaining),
    reset_at: String(record.reset_at),
  };
}
