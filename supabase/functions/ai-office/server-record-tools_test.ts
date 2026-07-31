import type { SupabaseClient } from '@supabase/supabase-js';
import { agentDefinitions } from '../../../src/core/ai/agents.ts';
import type { OfficeAgentName } from '../../../src/core/ai/contracts.ts';
import type { OfficeToolContext } from '../../../src/core/ai/tools.ts';
import {
  createServerAiOfficeToolRegistry,
  serverAiOfficeToolNames,
} from '../_shared/server-ai-office-tools.ts';

type Row = Record<string, unknown>;
type Filter =
  { kind: 'eq'; field: string; value: unknown } | { kind: 'in'; field: string; value: unknown[] };

class FakeQuery implements PromiseLike<{
  data: Row[] | null;
  count: number | null;
  error: null;
}> {
  private columns = '*';
  private countRequested = false;
  private readonly filters: Filter[] = [];

  constructor(private readonly rows: Row[]) {}

  select(columns: string, options?: { count?: string; head?: boolean }) {
    this.columns = columns;
    this.countRequested = options?.count === 'exact' && options.head === true;
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ kind: 'eq', field, value });
    return this;
  }

  in(field: string, value: unknown[]) {
    this.filters.push({ kind: 'in', field, value });
    return this;
  }

  private filtered(): Row[] {
    return this.rows.filter((row) =>
      this.filters.every((filter) =>
        filter.kind === 'eq'
          ? row[filter.field] === filter.value
          : filter.value.includes(row[filter.field]),
      ),
    );
  }

  private projected(rows: Row[]): Row[] {
    if (this.columns === '*') return structuredClone(rows);
    const columns = this.columns.split(',').map((column) => column.trim());
    return rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
  }

  maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.projected(this.filtered());
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  then<TResult1 = { data: Row[] | null; count: number | null; error: null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: Row[] | null;
          count: number | null;
          error: null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const rows = this.filtered();
    const result = this.countRequested
      ? { data: null, count: rows.length, error: null }
      : { data: this.projected(rows), count: null, error: null };
    return Promise.resolve(result).then(onfulfilled);
  }
}

class FakeReadClient {
  readonly queries: string[] = [];

  constructor(private readonly fixtures: Record<string, Row[]>) {}

  from(table: string) {
    this.queries.push(table);
    return new FakeQuery(this.fixtures[table] ?? []);
  }

  rpc(name: string, parameters: Record<string, unknown>) {
    if (name === 'load_storyops_ai_record') {
      const subjectType = String(parameters.p_subject_type);
      const table = `${subjectType}s`;
      this.queries.push(table);
      const row = (this.fixtures[table] ?? []).find(
        (candidate) =>
          candidate.company_id === parameters.p_company_id &&
          candidate.id === parameters.p_subject_id,
      );
      const columns: Record<string, string[]> = {
        lead: [
          'id',
          'status',
          'source',
          'requested_services',
          'preferred_contact_channel',
          'customer_id',
          'property_id',
          'updated_at',
          'version',
        ],
      };
      return Promise.resolve({
        data: row
          ? Object.fromEntries(
              (columns[subjectType] ?? ['id']).map((column) => [column, row[column]]),
            )
          : null,
        error: null,
      });
    }
    if (name === 'load_storyops_ai_service_codes') {
      this.queries.push('service_catalog');
      const requested = Array.isArray(parameters.p_codes) ? parameters.p_codes : [];
      const data = (this.fixtures.service_catalog ?? [])
        .filter(
          (row) =>
            row.company_id === parameters.p_company_id &&
            row.active === true &&
            requested.includes(row.code),
        )
        .map((row) => row.code);
      return Promise.resolve({ data, error: null });
    }
    if (name === 'load_storyops_ai_metrics') {
      const statuses = ['new', 'qualifying', 'qualified', 'unqualified', 'converted', 'lost'];
      const companyRows = (this.fixtures.leads ?? []).filter(
        (row) => row.company_id === parameters.p_company_id,
      );
      return Promise.resolve({
        data: {
          metrics: {
            leadsByStatus: Object.fromEntries(
              statuses.map((status) => [
                status,
                companyRows.filter((row) => row.status === status).length,
              ]),
            ),
          },
          unknowns: [],
        },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: { message: `Unexpected RPC ${name}.` } });
  }
}

class FakeCommandClient {
  readonly calls: Array<{ name: string; parameters: Record<string, unknown> }> = [];
  private readonly completed = new Map<string, string>();

  rpc(name: string, parameters: Record<string, unknown>) {
    this.calls.push({ name, parameters: structuredClone(parameters) });
    const commandId = String(parameters.p_command_id);
    const requestHash = String(parameters.p_request_hash);
    const priorHash = this.completed.get(commandId);
    if (priorHash && priorHash !== requestHash) {
      return Promise.resolve({
        data: null,
        error: { message: 'Command ID was reused with a different payload.' },
      });
    }
    const replayed = priorHash !== undefined;
    this.completed.set(commandId, requestHash);
    const payload = parameters.p_payload as Record<string, unknown>;
    return Promise.resolve({
      data: {
        commandId,
        commandType: parameters.p_command_type,
        status: 'applied',
        replayed,
        entityId: payload.entityId,
        version: parameters.p_command_type === 'lead.create' ? 1 : 3,
        requestHash,
        serverTime: '2026-07-29T14:00:00.000Z',
      },
      error: null,
    });
  }
}

const companyA = '10000000-0000-4000-8000-000000000001';
const companyB = '10000000-0000-4000-8000-000000000002';
const leadId = '20000000-0000-4000-8000-000000000001';
const fixedNow = new Date('2026-07-29T14:00:00.000Z');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function context(
  agent: OfficeAgentName,
  overrides: Partial<OfficeToolContext> = {},
): OfficeToolContext {
  return {
    companyId: companyA,
    runId: 'run-record-tools',
    actionId: 'action-record-tools',
    agent,
    actor: { id: '90000000-0000-4000-8000-000000000001', role: 'owner' },
    idempotencyKey: 'record-tool-idempotency-key',
    ...overrides,
  };
}

function registryWith(readClient: FakeReadClient, commandClient = new FakeCommandClient()) {
  const registry = createServerAiOfficeToolRegistry({
    readClient: readClient as unknown as SupabaseClient,
    commandClient: commandClient as unknown as SupabaseClient,
    now: () => fixedNow,
  });
  return { registry, commandClient };
}

Deno.test('the Edge runtime exposes only its finite server-authorized tool set', () => {
  const { registry } = registryWith(new FakeReadClient({}));
  const registered = new Set(registry.list().map((tool) => tool.name));
  assert(
    registered.size === serverAiOfficeToolNames.length &&
      serverAiOfficeToolNames.every((toolName) => registered.has(toolName)),
    `Unexpected production AI Office registry: ${[...registered].sort().join(', ')}`,
  );
  for (const toolName of registered) {
    assert(
      Object.values(agentDefinitions).some((definition) => definition.allowedTools.has(toolName)),
      `Production registry exposes a tool no specialist may use: ${toolName}.`,
    );
  }
  for (const forbidden of [
    'payments.read_status',
    'maps.geocode',
    'calendar.read_availability',
    'weather.read_forecast',
    'routing.optimize',
    'storage.read_asset',
    'accounting.export_invoice',
    'communications.send_email',
    'communications.send_sms',
  ] as const) {
    assert(!registered.has(forbidden), `Generic provider tool escaped into Edge: ${forbidden}.`);
  }
});

Deno.test('durable lead mutations cannot be classified for unattended execution', () => {
  const { registry } = registryWith(new FakeReadClient({}));
  for (const toolName of ['records.create_lead', 'records.update_lead'] as const) {
    const metadata = registry.metadata(toolName);
    assert(metadata !== undefined, `${toolName} is not registered.`);
    assert(metadata.reversible === false, `${toolName} was incorrectly marked reversible.`);
    assert(metadata.autoExecute === false, `${toolName} was incorrectly marked auto-executable.`);
    assert(
      metadata.sideEffect === 'internal_write',
      `${toolName} lost its durable-write boundary.`,
    );
  }
});

Deno.test(
  'records.read is exact-subject and tenant scoped and never returns direct lead PII',
  async () => {
    const readClient = new FakeReadClient({
      leads: [
        {
          id: leadId,
          company_id: companyA,
          status: 'qualifying',
          source: 'sms',
          display_name: 'Customer A Private Name',
          email: 'customer-a@example.test',
          phone: '+1 214 555 0100',
          requested_services: ['gutter-cleaning'],
          preferred_contact_channel: 'sms',
          customer_id: null,
          property_id: null,
          updated_at: fixedNow.toISOString(),
          version: 2,
        },
        {
          id: leadId,
          company_id: companyB,
          status: 'qualified',
          source: 'email',
          display_name: 'Customer B Private Name',
          email: 'customer-b@example.test',
          phone: '+1 214 555 0199',
          requested_services: ['soft-wash-house'],
          preferred_contact_channel: 'email',
          customer_id: null,
          property_id: null,
          updated_at: fixedNow.toISOString(),
          version: 7,
        },
      ],
    });
    const { registry } = registryWith(readClient);
    const output = await registry.execute(
      'records.read',
      { subjectType: 'lead', subjectId: leadId },
      context('intake'),
    );
    const serialized = JSON.stringify(output);

    assert(serialized.includes('gutter-cleaning'), 'The company A lead was not returned.');
    assert(
      !serialized.includes('soft-wash-house'),
      'A company B lead crossed the tenant boundary.',
    );
    for (const privateValue of [
      'Customer A Private Name',
      'Customer B Private Name',
      'customer-a@example.test',
      'customer-b@example.test',
      '214 555',
    ]) {
      assert(!serialized.includes(privateValue), `Direct PII leaked: ${privateValue}.`);
    }
  },
);

Deno.test(
  'lead writes use stable command IDs, catalog validation, optimistic versions, and strict payloads',
  async () => {
    const readClient = new FakeReadClient({
      service_catalog: [
        {
          company_id: companyA,
          code: 'gutter-cleaning',
          active: true,
        },
        {
          company_id: companyB,
          code: 'soft-wash-house',
          active: true,
        },
      ],
    });
    const { registry, commandClient } = registryWith(readClient);
    const input = {
      source: 'sms',
      displayName: 'Inbound prospect',
      requestedServices: ['gutter-cleaning'],
      preferredContactChannel: 'sms',
    };
    const first = await registry.execute('records.create_lead', input, context('intake'));
    const replay = await registry.execute('records.create_lead', input, context('intake'));
    const [firstCall, replayCall] = commandClient.calls;
    assert(firstCall?.name === 'execute_storyops_command', 'Create bypassed the command RPC.');
    assert(
      firstCall.parameters.p_command_id === replayCall?.parameters.p_command_id,
      'Identical execution contexts did not produce a stable command ID.',
    );
    assert(
      (first as { replayed?: boolean }).replayed === false &&
        (replay as { replayed?: boolean }).replayed === true,
      'The durable command replay receipt was not preserved.',
    );
    let idempotencyConflictRejected = false;
    try {
      await registry.execute(
        'records.create_lead',
        { ...input, displayName: 'Different prospect' },
        context('intake'),
      );
    } catch {
      idempotencyConflictRejected = true;
    }
    assert(
      idempotencyConflictRejected,
      'The same deterministic command ID accepted a different payload.',
    );

    await registry.execute(
      'records.update_lead',
      {
        leadId,
        expectedVersion: 2,
        status: 'qualified',
        qualificationSummary: 'Requested service and timing were confirmed.',
      },
      context('follow_up', {
        actionId: 'qualify-lead',
        idempotencyKey: 'lead-qualification-idempotency',
      }),
    );
    const qualifyCall = commandClient.calls.at(-1);
    assert(
      qualifyCall?.parameters.p_command_type === 'lead.qualify' &&
        qualifyCall.parameters.p_expected_version === 2,
      'Qualification did not preserve the finite optimistic command boundary.',
    );

    for (const unsafePayload of [
      { ...input, email: 'untrusted@example.test' },
      { ...input, price: '500.00' },
      { ...input, paymentStatus: 'paid' },
    ]) {
      let rejected = false;
      try {
        await registry.execute('records.create_lead', unsafePayload, context('intake'));
      } catch {
        rejected = true;
      }
      assert(rejected, 'A caller-supplied PII, price, or payment field was accepted.');
    }

    let unsupportedServiceRejected = false;
    try {
      await registry.execute(
        'records.create_lead',
        { ...input, requestedServices: ['soft-wash-house'] },
        context('intake', { idempotencyKey: 'unsupported-service-key' }),
      );
    } catch {
      unsupportedServiceRejected = true;
    }
    assert(
      unsupportedServiceRejected,
      'A different tenant service code passed active-catalog validation.',
    );
  },
);

Deno.test('metrics.read returns exact company counts with as-of and completeness', async () => {
  const readClient = new FakeReadClient({
    leads: [
      { id: '1', company_id: companyA, status: 'new' },
      { id: '2', company_id: companyA, status: 'new' },
      { id: '3', company_id: companyA, status: 'qualified' },
      { id: '4', company_id: companyA, status: 'converted' },
      { id: '5', company_id: companyB, status: 'new' },
      { id: '6', company_id: companyB, status: 'qualified' },
    ],
  });
  const { registry } = registryWith(readClient);
  const output = (await registry.execute(
    'metrics.read',
    { metricSet: 'pipeline' },
    context('owner_briefing'),
  )) as {
    asOf: string;
    completeness: { complete: boolean; method: string; unknowns: string[] };
    metrics: { leadsByStatus: Record<string, number | null> };
  };

  assert(output.asOf === fixedNow.toISOString(), 'Metric as-of time was not server-derived.');
  assert(output.completeness.complete, 'Exact fixture counts were marked incomplete.');
  assert(
    output.completeness.method === 'exact_server_counts' &&
      output.completeness.unknowns.length === 0,
    'Metric completeness evidence was invalid.',
  );
  assert(
    output.metrics.leadsByStatus.new === 2 &&
      output.metrics.leadsByStatus.qualified === 1 &&
      output.metrics.leadsByStatus.converted === 1 &&
      output.metrics.leadsByStatus.lost === 0,
    'Pipeline metric counts were incorrect.',
  );
});
