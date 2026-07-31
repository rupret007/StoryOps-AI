import type { SupabaseClient } from '@supabase/supabase-js';
import type { TrustedFact } from '../../../src/core/ai/contracts.ts';
import {
  AuthoritativeFactScopeError,
  resolveAuthoritativeFacts,
} from '../_shared/authoritative-facts.ts';

type Row = Record<string, unknown>;
type Filter =
  | { kind: 'eq'; field: string; value: unknown }
  | { kind: 'in'; field: string; value: unknown[] }
  | { kind: 'gt'; field: string; value: unknown };

class FakeQuery implements PromiseLike<{ data: Row[]; error: null }> {
  private selected = '*';
  private readonly filters: Filter[] = [];
  private maximum = Number.POSITIVE_INFINITY;

  constructor(private readonly rows: Row[]) {}

  select(columns: string) {
    this.selected = columns;
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

  gt(field: string, value: unknown) {
    this.filters.push({ kind: 'gt', field, value });
    return this;
  }

  order() {
    return this;
  }

  limit(value: number) {
    this.maximum = value;
    return this;
  }

  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onfulfilled?:
      ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const columns = this.selected.split(',').map((column) => column.trim());
    const data = this.rows
      .filter((row) =>
        this.filters.every((filter) => {
          if (filter.kind === 'eq') return row[filter.field] === filter.value;
          if (filter.kind === 'in') return filter.value.includes(row[filter.field]);
          return String(row[filter.field]) > String(filter.value);
        }),
      )
      .slice(0, this.maximum)
      .map((row) =>
        columns[0] === '*'
          ? structuredClone(row)
          : Object.fromEntries(columns.map((column) => [column, row[column]])),
      );
    return Promise.resolve({ data, error: null }).then(onfulfilled);
  }
}

class FakeClient {
  readonly queriedTables: string[] = [];

  constructor(private readonly fixtures: Record<string, Row[]>) {}

  from(table: string) {
    this.queriedTables.push(table);
    return new FakeQuery(this.fixtures[table] ?? []);
  }

  rpc(name: string, args: Record<string, unknown>) {
    if (name === 'load_storyops_ai_owner_briefing_rows') {
      return {
        data: {
          leads: (this.fixtures.leads ?? []).slice(0, 1_001).map(({ status }) => ({ status })),
          jobs: (this.fixtures.jobs ?? []).slice(0, 1_001).map(({ status }) => ({ status })),
          invoices: (this.fixtures.invoices ?? [])
            .slice(0, 1_001)
            .map(({ status, balance_due, due_date }) => ({ status, balance_due, due_date })),
          approvals: (this.fixtures.approval_requests ?? [])
            .slice(0, 1_001)
            .map(({ status, risk_level }) => ({ status, risk_level })),
        },
        error: null,
      };
    }
    if (name !== 'load_storyops_ai_fact_rows') {
      return { data: [], error: null };
    }
    const table = String(args.p_table);
    const field = String(args.p_field);
    const values = Array.isArray(args.p_values) ? args.p_values : [];
    const limit = Number(args.p_limit);
    this.queriedTables.push(table);
    const columns: Record<string, string[]> = {
      leads: [
        'id',
        'status',
        'source',
        'customer_id',
        'property_id',
        'requested_services',
        'preferred_contact_channel',
        'updated_at',
        'version',
      ],
      customers: ['id', 'lifecycle', 'do_not_contact', 'tax_exempt', 'updated_at', 'version'],
      consent_records: [
        'id',
        'customer_id',
        'lead_id',
        'channel',
        'purpose',
        'status',
        'captured_at',
        'capture_method',
        'withdrawn_at',
        'updated_at',
        'version',
      ],
    };
    const data = (this.fixtures[table] ?? [])
      .filter((row) => row.company_id === args.p_company_id && values.includes(row[field] as never))
      .slice(0, limit)
      .map((row) =>
        Object.fromEntries((columns[table] ?? ['id']).map((column) => [column, row[column]])),
      );
    return { data, error: null };
  }
}

const companyId = '10000000-0000-4000-8000-000000000001';
const leadA = '20000000-0000-4000-8000-000000000001';
const leadB = '20000000-0000-4000-8000-000000000002';
const customerA = '30000000-0000-4000-8000-000000000001';
const customerB = '30000000-0000-4000-8000-000000000002';
const propertyA = '40000000-0000-4000-8000-000000000001';
const propertyB = '40000000-0000-4000-8000-000000000002';
const paymentB = '50000000-0000-4000-8000-000000000002';
const consentA = '60000000-0000-4000-8000-000000000001';
const observedAt = '2026-07-29T12:00:00.000Z';

function selector(id: string, name: string, value: unknown): TrustedFact {
  return {
    id,
    name,
    value,
    source: 'human',
    observedAt,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test(
  'intake facts stay on customer A and exclude unrelated customer, payment, and address records',
  async () => {
    const client = new FakeClient({
      leads: [
        {
          id: leadA,
          company_id: companyId,
          status: 'qualifying',
          source: 'sms',
          display_name: 'Customer A private name',
          email: 'customer-a@example.test',
          phone: '+1 214 555 0100',
          customer_id: customerA,
          property_id: propertyA,
          requested_services: ['GUTTER_CLEAN'],
          preferred_contact_channel: 'sms',
          updated_at: observedAt,
          version: 2,
        },
        {
          id: leadB,
          company_id: companyId,
          status: 'new',
          source: 'web',
          display_name: 'Customer B private name',
          email: 'customer-b@example.test',
          phone: '+1 214 555 0199',
          customer_id: customerB,
          property_id: propertyB,
          requested_services: ['HOUSE_WASH'],
          preferred_contact_channel: 'email',
          updated_at: observedAt,
          version: 1,
        },
      ],
      customers: [
        {
          id: customerA,
          company_id: companyId,
          display_name: 'Customer A private name',
          email: 'customer-a@example.test',
          billing_address: { line1: '101 Customer A Private Street' },
          lifecycle: 'lead',
          do_not_contact: false,
          tax_exempt: false,
          updated_at: observedAt,
          version: 1,
        },
        {
          id: customerB,
          company_id: companyId,
          display_name: 'Customer B private name',
          email: 'customer-b@example.test',
          billing_address: { line1: '202 Customer B Private Street' },
          lifecycle: 'active',
          do_not_contact: false,
          tax_exempt: false,
          updated_at: observedAt,
          version: 1,
        },
      ],
      properties: [
        {
          id: propertyA,
          company_id: companyId,
          customer_id: customerA,
          service_address: { line1: '101 Customer A Private Street' },
        },
        {
          id: propertyB,
          company_id: companyId,
          customer_id: customerB,
          service_address: { line1: '202 Customer B Private Street' },
        },
      ],
      payments: [
        {
          id: paymentB,
          company_id: companyId,
          customer_id: customerB,
          provider_payment_id: 'pi_customer_b_private',
          amount: '900.00',
        },
      ],
      consent_records: [
        {
          id: consentA,
          company_id: companyId,
          customer_id: null,
          lead_id: leadA,
          channel: 'sms',
          purpose: 'transactional',
          status: 'granted',
          captured_at: observedAt,
          capture_method: 'keyword',
          proof: 'private proof',
          withdrawn_at: null,
          updated_at: observedAt,
          version: 1,
        },
      ],
    });

    const facts = await resolveAuthoritativeFacts(
      client as unknown as SupabaseClient,
      companyId,
      {
        agent: 'intake',
        trustedFacts: [
          selector(`leads:${leadA}`, 'lead_id', leadA),
          selector(`customers:${customerB}`, 'customer_id', customerB),
          selector(`payments:${paymentB}`, 'payment_id', paymentB),
        ],
      },
      '10000000-0000-4000-8000-000000000101',
    );
    const names = new Set(facts.map((fact) => fact.name));
    const serialized = JSON.stringify(facts);

    for (const expected of ['authoritative_scope', 'leads', 'customers', 'consent_records']) {
      assert(names.has(expected), `Expected minimized ${expected} fact.`);
    }
    assert(serialized.includes(leadA), 'Customer A lead was not resolved.');
    assert(serialized.includes(customerA), 'Customer A was not resolved.');
    assert(!serialized.includes(leadB), 'Unrelated lead B reached the model facts.');
    assert(!serialized.includes(customerB), 'Unrelated customer B reached the model facts.');
    assert(!serialized.includes(paymentB), 'Unrelated payment B reached the model facts.');
    assert(
      !serialized.includes('pi_customer_b_private'),
      'A provider payment identifier reached the model facts.',
    );
    assert(!serialized.includes('Private Street'), 'An address reached the model facts.');
    assert(
      !serialized.includes('customer-a@example.test'),
      'A direct contact identifier reached the model facts.',
    );
    assert(
      !serialized.includes('Customer A private name'),
      'A customer display name reached the model facts.',
    );
    for (const prohibitedTable of ['properties', 'payments', 'invoices']) {
      assert(
        !client.queriedTables.includes(prohibitedTable),
        `Intake queried prohibited table ${prohibitedTable}.`,
      );
    }
  },
);

Deno.test('ambiguous same-kind root subjects fail before any database query', async () => {
  const client = new FakeClient({});
  let rejected: unknown;
  try {
    await resolveAuthoritativeFacts(
      client as unknown as SupabaseClient,
      companyId,
      {
        agent: 'intake',
        trustedFacts: [
          selector(`leads:${leadA}`, 'lead_id', leadA),
          selector(`leads:${leadB}`, 'lead_id', leadB),
        ],
      },
      '10000000-0000-4000-8000-000000000101',
    );
  } catch (error) {
    rejected = error;
  }
  assert(
    rejected instanceof AuthoritativeFactScopeError,
    'Ambiguous intake subjects did not fail closed.',
  );
  assert(client.queriedTables.length === 0, 'Ambiguous subjects reached the database.');
});

Deno.test('related-record caps are explicit model-facing unknowns', async () => {
  const client = new FakeClient({
    customers: [
      {
        id: customerA,
        company_id: companyId,
        lifecycle: 'lead',
        do_not_contact: false,
        tax_exempt: false,
        updated_at: observedAt,
        version: 1,
      },
    ],
    leads: Array.from({ length: 51 }, (_, index) => ({
      id: `71000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      company_id: companyId,
      customer_id: customerA,
      status: 'new',
      source: 'web',
      requested_services: [],
      preferred_contact_channel: 'email',
      updated_at: observedAt,
      version: 1,
    })),
  });
  const facts = await resolveAuthoritativeFacts(
    client as unknown as SupabaseClient,
    companyId,
    {
      agent: 'intake',
      trustedFacts: [selector(`customers:${customerA}`, 'customer_id', customerA)],
    },
    '10000000-0000-4000-8000-000000000101',
  );
  const summary = facts.find((fact) => fact.name === 'authoritative_scope')?.value as {
    relationshipFactsComplete?: boolean;
    truncatedRelationships?: string[];
    unknowns?: string[];
    resolvedFactCounts?: { leads?: number };
  };
  assert(summary.relationshipFactsComplete === false, 'Capped relationship claimed complete data.');
  assert(
    summary.truncatedRelationships?.includes('leads.customer_id') === true,
    'Capped relationship identity was omitted.',
  );
  assert(summary.resolvedFactCounts?.leads === 50, 'Relationship did not enforce its 50-row cap.');
  assert(
    summary.unknowns?.some((unknown) => unknown.includes('leads.customer_id')) === true,
    'Capped relationship omitted its model-facing unknown.',
  );
});

Deno.test('owner briefing marks capped aggregates incomplete', async () => {
  const client = new FakeClient({
    leads: Array.from({ length: 1_001 }, () => ({
      company_id: companyId,
      status: 'new',
    })),
  });
  const facts = await resolveAuthoritativeFacts(
    client as unknown as SupabaseClient,
    companyId,
    {
      agent: 'owner_briefing',
      trustedFacts: [],
    },
    '10000000-0000-4000-8000-000000000101',
  );
  const value = facts[0]?.value as {
    aggregationComplete?: boolean;
    completeness?: { leads?: boolean };
    unknowns?: string[];
  };
  assert(value.aggregationComplete === false, 'Capped briefing claimed complete data.');
  assert(value.completeness?.leads === false, 'Lead cap was not identified.');
  assert(
    value.unknowns?.some((unknown) => unknown.includes('leads exceeded')) === true,
    'Capped briefing omitted its lead-count unknown.',
  );
});
