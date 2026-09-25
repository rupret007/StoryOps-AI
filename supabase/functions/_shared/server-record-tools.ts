import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { OfficeAgentName } from '../../../src/core/ai/contracts.ts';
import { jsonValueSchema } from '../../../src/core/ai/contracts.ts';
import type { OfficeToolRegistry } from '../../../src/core/ai/tools.ts';
import { ToolExecutionError } from '../../../src/core/ai/tools.ts';

type Row = Record<string, unknown>;

const subjectTypes = [
  'lead',
  'customer',
  'property',
  'estimate',
  'quote',
  'job',
  'visit',
  'invoice',
  'payment',
  'incident',
  'review',
  'approval',
] as const;
type RecordSubjectType = (typeof subjectTypes)[number];

type RecordSpec = {
  table: string;
  columns: string;
  project: (row: Row) => Record<string, unknown>;
};

function value(row: Row, key: string): unknown {
  return row[key] ?? null;
}

const recordSpecs: Readonly<Record<RecordSubjectType, RecordSpec>> = {
  lead: {
    table: 'leads',
    columns:
      'id,status,source,requested_services,preferred_contact_channel,customer_id,property_id,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      status: value(row, 'status'),
      source: value(row, 'source'),
      requestedServices: value(row, 'requested_services'),
      preferredContactChannel: value(row, 'preferred_contact_channel'),
      customerId: value(row, 'customer_id'),
      propertyId: value(row, 'property_id'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  customer: {
    table: 'customers',
    columns: 'id,lifecycle,do_not_contact,tax_exempt,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      lifecycle: value(row, 'lifecycle'),
      doNotContact: value(row, 'do_not_contact'),
      taxExempt: value(row, 'tax_exempt'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  property: {
    table: 'properties',
    columns:
      'id,customer_id,property_type,stories,geocoded_at,last_serviced_at,known_hazards,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      customerId: value(row, 'customer_id'),
      propertyType: value(row, 'property_type'),
      stories: value(row, 'stories'),
      geocoded: typeof row.geocoded_at === 'string',
      knownHazardCount: Array.isArray(row.known_hazards) ? row.known_hazards.length : 0,
      lastServicedAt: value(row, 'last_serviced_at'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  estimate: {
    table: 'estimates',
    columns:
      'id,customer_id,property_id,lead_id,price_book_id,price_book_version,status,total,deposit_required,estimated_margin_pct,duration_minutes,calculated_at,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      customerId: value(row, 'customer_id'),
      propertyId: value(row, 'property_id'),
      leadId: value(row, 'lead_id'),
      priceBookId: value(row, 'price_book_id'),
      priceBookVersion: value(row, 'price_book_version'),
      status: value(row, 'status'),
      total: value(row, 'total'),
      depositRequired: value(row, 'deposit_required'),
      estimatedMarginPercent: value(row, 'estimated_margin_pct'),
      durationMinutes: value(row, 'duration_minutes'),
      calculatedAt: value(row, 'calculated_at'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  quote: {
    table: 'quotes',
    columns:
      'id,estimate_id,customer_id,property_id,status,valid_until,total,deposit_required,sent_at,accepted_at,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      estimateId: value(row, 'estimate_id'),
      customerId: value(row, 'customer_id'),
      propertyId: value(row, 'property_id'),
      status: value(row, 'status'),
      validUntil: value(row, 'valid_until'),
      total: value(row, 'total'),
      depositRequired: value(row, 'deposit_required'),
      sentAt: value(row, 'sent_at'),
      acceptedAt: value(row, 'accepted_at'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  job: {
    table: 'jobs',
    columns:
      'id,quote_id,customer_id,property_id,status,priority,service_codes,estimated_duration_minutes,estimated_revenue,estimated_cost,assigned_crew_id,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      quoteId: value(row, 'quote_id'),
      customerId: value(row, 'customer_id'),
      propertyId: value(row, 'property_id'),
      status: value(row, 'status'),
      priority: value(row, 'priority'),
      serviceCodes: value(row, 'service_codes'),
      estimatedDurationMinutes: value(row, 'estimated_duration_minutes'),
      estimatedRevenue: value(row, 'estimated_revenue'),
      estimatedCost: value(row, 'estimated_cost'),
      assignedCrewId: value(row, 'assigned_crew_id'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  visit: {
    table: 'visits',
    columns:
      'id,job_id,status,starts_at,ends_at,crew_id,route_check_id,weather_check_id,offline_revision,last_synced_at,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      jobId: value(row, 'job_id'),
      status: value(row, 'status'),
      startsAt: value(row, 'starts_at'),
      endsAt: value(row, 'ends_at'),
      crewId: value(row, 'crew_id'),
      routeCheckId: value(row, 'route_check_id'),
      weatherCheckId: value(row, 'weather_check_id'),
      offlineRevision: value(row, 'offline_revision'),
      lastSyncedAt: value(row, 'last_synced_at'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  invoice: {
    table: 'invoices',
    columns:
      'id,customer_id,job_id,status,issue_date,due_date,subtotal,tax,total,amount_paid,balance_due,sent_at,paid_at,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      customerId: value(row, 'customer_id'),
      jobId: value(row, 'job_id'),
      status: value(row, 'status'),
      issueDate: value(row, 'issue_date'),
      dueDate: value(row, 'due_date'),
      subtotal: value(row, 'subtotal'),
      tax: value(row, 'tax'),
      total: value(row, 'total'),
      amountPaid: value(row, 'amount_paid'),
      balanceDue: value(row, 'balance_due'),
      sentAt: value(row, 'sent_at'),
      paidAt: value(row, 'paid_at'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  payment: {
    table: 'payments',
    columns: 'id,invoice_id,customer_id,payment_type,status,amount,processed_at,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      invoiceId: value(row, 'invoice_id'),
      customerId: value(row, 'customer_id'),
      paymentType: value(row, 'payment_type'),
      status: value(row, 'status'),
      amount: value(row, 'amount'),
      processedAt: value(row, 'processed_at'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  incident: {
    table: 'incidents',
    columns:
      'id,job_id,visit_id,property_id,severity,status,category,occurred_at,reported_at,owner_notified_at,requires_legal_review,closed_at,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      jobId: value(row, 'job_id'),
      visitId: value(row, 'visit_id'),
      propertyId: value(row, 'property_id'),
      severity: value(row, 'severity'),
      status: value(row, 'status'),
      category: value(row, 'category'),
      occurredAt: value(row, 'occurred_at'),
      reportedAt: value(row, 'reported_at'),
      ownerNotifiedAt: value(row, 'owner_notified_at'),
      requiresLegalReview: value(row, 'requires_legal_review'),
      closedAt: value(row, 'closed_at'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  review: {
    table: 'reviews',
    columns:
      'id,customer_id,job_id,provider,rating,received_at,sentiment,response_status,approval_request_id,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      customerId: value(row, 'customer_id'),
      jobId: value(row, 'job_id'),
      provider: value(row, 'provider'),
      rating: value(row, 'rating'),
      receivedAt: value(row, 'received_at'),
      sentiment: value(row, 'sentiment'),
      responseStatus: value(row, 'response_status'),
      approvalRequestId: value(row, 'approval_request_id'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
  approval: {
    table: 'approval_requests',
    columns:
      'id,reason,risk_level,status,requested_at,expires_at,entity_type,entity_id,action_type,decided_at,consumed_at,updated_at,version',
    project: (row) => ({
      id: value(row, 'id'),
      reason: value(row, 'reason'),
      riskLevel: value(row, 'risk_level'),
      status: value(row, 'status'),
      requestedAt: value(row, 'requested_at'),
      expiresAt: value(row, 'expires_at'),
      entityType: value(row, 'entity_type'),
      entityId: value(row, 'entity_id'),
      actionType: value(row, 'action_type'),
      decidedAt: value(row, 'decided_at'),
      consumedAt: value(row, 'consumed_at'),
      updatedAt: value(row, 'updated_at'),
      version: value(row, 'version'),
    }),
  },
};

const agentRecordAccess: Readonly<Record<OfficeAgentName, ReadonlySet<RecordSubjectType>>> = {
  intake: new Set(['lead', 'customer']),
  estimating: new Set(['lead', 'customer', 'property', 'estimate', 'quote']),
  scheduling: new Set(['property', 'job', 'visit']),
  follow_up: new Set(['lead', 'customer', 'quote', 'job', 'invoice']),
  marketing: new Set(['customer', 'job', 'review']),
  finance: new Set(['customer', 'quote', 'job', 'invoice', 'payment']),
  safety: new Set(['property', 'job', 'visit', 'incident']),
  owner_briefing: new Set(subjectTypes),
};

const recordReadInputSchema = z
  .object({
    subjectType: z.enum(subjectTypes),
    subjectId: z.string().uuid(),
  })
  .strict();

const recordReadOutputSchema = z
  .object({
    subjectType: z.enum(subjectTypes),
    subjectId: z.string().uuid(),
    found: z.boolean(),
    record: z.record(z.string(), jsonValueSchema).nullable(),
    asOf: z.string().datetime({ offset: true }),
    completeness: z
      .object({
        complete: z.literal(true),
        scope: z.literal('exact_subject'),
      })
      .strict(),
  })
  .strict();

export const leadCreateInputSchema = z
  .object({
    source: z.enum(['web', 'chat', 'sms', 'phone', 'email', 'referral', 'manual']),
    displayName: z.string().trim().min(1).max(160),
    requestedServices: z
      .array(
        z
          .string()
          .regex(
            /^[a-z0-9][a-z0-9_-]{0,79}$/u,
            'Requested services must use exact active catalog codes.',
          ),
      )
      .max(12)
      .default([]),
    preferredContactChannel: z.enum(['email', 'sms', 'phone']).optional(),
  })
  .strict();

export const leadUpdateInputSchema = z
  .object({
    leadId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    status: z.enum(['qualifying', 'qualified', 'unqualified', 'lost']),
    qualificationSummary: z.string().trim().min(1).max(2_000).optional(),
    disqualificationReason: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.status === 'unqualified' && !input.disqualificationReason) {
      context.addIssue({
        code: 'custom',
        path: ['disqualificationReason'],
        message: 'Unqualified leads require a disqualification reason.',
      });
    }
    if (input.status !== 'unqualified' && input.disqualificationReason) {
      context.addIssue({
        code: 'custom',
        path: ['disqualificationReason'],
        message: 'Only an unqualified lead may include a disqualification reason.',
      });
    }
  });

const commandReceiptSchema = z
  .object({
    commandId: z.string().uuid(),
    commandType: z.enum(['lead.create', 'lead.qualify']),
    status: z.literal('applied'),
    replayed: z.boolean(),
    entityId: z.string().uuid(),
    version: z.number().int().positive(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    serverTime: z.string().datetime({ offset: true }),
  })
  .passthrough();

const metricSetSchema = z.enum(['pipeline', 'operations', 'finance']);
type MetricSet = z.infer<typeof metricSetSchema>;

const metricsReadInputSchema = z
  .object({
    metricSet: metricSetSchema,
  })
  .strict();

const nullableCountSchema = z.number().int().nonnegative().nullable();
const metricsReadOutputSchema = z
  .object({
    metricSet: metricSetSchema,
    asOf: z.string().datetime({ offset: true }),
    completeness: z
      .object({
        complete: z.boolean(),
        method: z.literal('exact_server_counts'),
        unknowns: z.array(z.string().min(1).max(500)).max(50),
      })
      .strict(),
    metrics: z.record(z.string(), z.record(z.string(), nullableCountSchema)),
  })
  .strict();

export type ServerRecordToolDependencies = {
  readClient: SupabaseClient;
  commandClient: SupabaseClient;
  now?: () => Date;
};

function boundaryError(message: string, code: string, cause?: unknown): ToolExecutionError {
  return new ToolExecutionError(message, {
    retryable: false,
    providerCode: code,
    cause,
  });
}

async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deterministicUuid(value: string): Promise<string> {
  const hex = await sha256Hex(value);
  const bytes = hex.slice(0, 32).split('');
  bytes[12] = '4';
  const variant = Number.parseInt(bytes[16] ?? '0', 16);
  bytes[16] = ((variant & 0x3) | 0x8).toString(16);
  const normalized = bytes.join('');
  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20),
  ].join('-');
}

async function validateServiceCodes(
  client: SupabaseClient,
  companyId: string,
  actorUserId: string,
  requestedServices: readonly string[],
): Promise<void> {
  const uniqueCodes = [...new Set(requestedServices)];
  if (uniqueCodes.length !== requestedServices.length) {
    throw boundaryError('Requested service codes must be unique.', 'DUPLICATE_REQUESTED_SERVICE');
  }
  if (uniqueCodes.length === 0) return;
  const { data, error } = await client.rpc('load_storyops_ai_service_codes', {
    p_company_id: companyId,
    p_actor_user_id: actorUserId,
    p_codes: uniqueCodes,
  });
  if (error) {
    throw boundaryError(
      'Active service catalog could not be verified.',
      'SERVICE_CATALOG_UNAVAILABLE',
      error,
    );
  }
  const approvedCodes = new Set(
    (Array.isArray(data) ? data : [])
      .map((code) => (typeof code === 'string' ? code : ''))
      .filter((code) => code.length > 0),
  );
  const unsupported = uniqueCodes.filter((code) => !approvedCodes.has(code));
  if (unsupported.length > 0) {
    throw boundaryError(
      `Requested service codes are outside the active catalog: ${unsupported.join(', ')}.`,
      'SERVICE_CODE_NOT_APPROVED',
    );
  }
}

async function executeLeadCommand(
  client: SupabaseClient,
  context: {
    companyId: string;
    idempotencyKey: string;
  },
  commandType: 'lead.create' | 'lead.qualify',
  expectedVersion: number,
  payload: Record<string, unknown>,
): Promise<z.infer<typeof commandReceiptSchema>> {
  const commandId = await deterministicUuid(
    `storyops:ai-office:record-command:${context.companyId}:${context.idempotencyKey}`,
  );
  const requestHash = await sha256Hex({
    commandType,
    expectedVersion,
    payload,
  });
  const { data, error } = await client.rpc('execute_storyops_command', {
    p_company_id: context.companyId,
    p_command_id: commandId,
    p_command_type: commandType,
    p_expected_version: expectedVersion,
    p_payload: payload,
    p_request_hash: requestHash,
  });
  if (error) {
    throw boundaryError(
      `WashOps ${commandType} command was rejected.`,
      'STORYOPS_COMMAND_REJECTED',
      error,
    );
  }
  const parsed = commandReceiptSchema.safeParse(data);
  if (!parsed.success || parsed.data.commandId !== commandId) {
    throw boundaryError(
      `WashOps ${commandType} command returned an invalid receipt.`,
      'INVALID_COMMAND_RECEIPT',
    );
  }
  return parsed.data;
}

async function loadMetrics(
  client: SupabaseClient,
  companyId: string,
  actorUserId: string,
  metricSet: MetricSet,
): Promise<{
  metrics: Record<string, Record<string, number | null>>;
  unknowns: string[];
}> {
  const { data, error } = await client.rpc('load_storyops_ai_metrics', {
    p_company_id: companyId,
    p_actor_user_id: actorUserId,
    p_metric_set: metricSet,
  });
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw boundaryError('Exact metrics could not be read.', 'METRICS_UNAVAILABLE', error);
  }
  const result = data as unknown as {
    metrics?: Record<string, Record<string, number | null>>;
    unknowns?: string[];
  };
  if (!result.metrics || !Array.isArray(result.unknowns)) {
    throw boundaryError('Exact metrics response was invalid.', 'METRICS_UNAVAILABLE');
  }
  return { metrics: result.metrics, unknowns: result.unknowns };
}

export function registerServerRecordTools(
  registry: OfficeToolRegistry,
  dependencies: ServerRecordToolDependencies,
): OfficeToolRegistry {
  const now = dependencies.now ?? (() => new Date());

  registry.register({
    name: 'records.read',
    description:
      'Read one exact company-owned subject through a specialist allowlist. Output excludes direct contact data, addresses, message bodies, notes, provider IDs, secrets, and payment assertions.',
    input: recordReadInputSchema,
    output: recordReadOutputSchema,
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    execute: async ({ subjectType, subjectId }, context) => {
      if (!agentRecordAccess[context.agent].has(subjectType)) {
        throw boundaryError(
          `${context.agent} cannot read ${subjectType} records.`,
          'SUBJECT_NOT_ALLOWED',
        );
      }
      const spec = recordSpecs[subjectType];
      const { data, error } = await dependencies.readClient.rpc('load_storyops_ai_record', {
        p_company_id: context.companyId,
        p_actor_user_id: context.actor.id,
        p_agent: context.agent,
        p_subject_type: subjectType,
        p_subject_id: subjectId,
      });
      if (error) {
        throw boundaryError(
          `The ${subjectType} record could not be read.`,
          'RECORD_READ_UNAVAILABLE',
          error,
        );
      }
      return {
        subjectType,
        subjectId,
        found: data !== null,
        record: data ? spec.project(data as unknown as Row) : null,
        asOf: now().toISOString(),
        completeness: {
          complete: true as const,
          scope: 'exact_subject' as const,
        },
      };
    },
  });

  registry.register({
    name: 'records.create_lead',
    description:
      'Create an idempotent durable lead shell through the finite authenticated command boundary. The write has no unattended compensating command and therefore requires exact-payload approval. Contact data, consent, addresses, prices, payments, provider state, and merge behavior are intentionally unsupported.',
    input: leadCreateInputSchema,
    output: commandReceiptSchema,
    risk: 'low',
    sideEffect: 'internal_write',
    reversible: false,
    supportsIdempotency: true,
    autoExecute: false,
    execute: async (input, context) => {
      if (context.agent !== 'intake') {
        throw boundaryError('Only the intake specialist may create a lead.', 'AGENT_NOT_ALLOWED');
      }
      await validateServiceCodes(
        dependencies.readClient,
        context.companyId,
        context.actor.id,
        input.requestedServices,
      );
      const entityId = await deterministicUuid(
        `storyops:ai-office:lead:${context.companyId}:${context.idempotencyKey}`,
      );
      return executeLeadCommand(dependencies.commandClient, context, 'lead.create', 0, {
        entityId,
        source: input.source,
        displayName: input.displayName,
        requestedServices: input.requestedServices,
        ...(input.preferredContactChannel
          ? { preferredContactChannel: input.preferredContactChannel }
          : {}),
      });
    },
  });

  registry.register({
    name: 'records.update_lead',
    description:
      'Idempotently apply one durable optimistic lead qualification transition. Qualification, loss, and disqualification have no exact unattended compensating command and therefore require exact-payload approval. Contact data, scope linking, conversion, pricing, payment/provider state, and arbitrary fields are unsupported.',
    input: leadUpdateInputSchema,
    output: commandReceiptSchema,
    risk: 'low',
    sideEffect: 'internal_write',
    reversible: false,
    supportsIdempotency: true,
    autoExecute: false,
    execute: (input, context) => {
      if (context.agent !== 'intake' && context.agent !== 'follow_up') {
        throw boundaryError(
          'Only intake and follow-up specialists may qualify a lead.',
          'AGENT_NOT_ALLOWED',
        );
      }
      return executeLeadCommand(
        dependencies.commandClient,
        context,
        'lead.qualify',
        input.expectedVersion,
        {
          entityId: input.leadId,
          status: input.status,
          ...(input.qualificationSummary
            ? { qualificationSummary: input.qualificationSummary }
            : {}),
          ...(input.disqualificationReason
            ? { disqualificationReason: input.disqualificationReason }
            : {}),
        },
      );
    },
  });

  registry.register({
    name: 'metrics.read',
    description:
      'Read one bounded server-derived KPI set as exact tenant-scoped status counts with an as-of time and explicit completeness.',
    input: metricsReadInputSchema,
    output: metricsReadOutputSchema,
    risk: 'low',
    sideEffect: 'none',
    reversible: true,
    supportsIdempotency: true,
    autoExecute: true,
    execute: async ({ metricSet }, context) => {
      if (context.agent !== 'owner_briefing') {
        throw boundaryError(
          'Only the owner-briefing specialist may read aggregate KPIs.',
          'AGENT_NOT_ALLOWED',
        );
      }
      const result = await loadMetrics(
        dependencies.readClient,
        context.companyId,
        context.actor.id,
        metricSet,
      );
      return {
        metricSet,
        asOf: now().toISOString(),
        completeness: {
          complete: result.unknowns.length === 0,
          method: 'exact_server_counts' as const,
          unknowns: result.unknowns,
        },
        metrics: result.metrics,
      };
    },
  });

  return registry;
}
