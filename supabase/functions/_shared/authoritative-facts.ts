import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  OfficeAgentName,
  OfficeRunRequest,
  TrustedFact,
} from '../../../src/core/ai/contracts.ts';
import {
  schedulingBookingFactsFromRows,
  schedulingTrustedFactsFromRows,
  type SchedulingConsumptionRow,
  type SchedulingJobRow,
  type SchedulingReceiptRow,
  type SchedulingRouteCheckRow,
  type SchedulingVisitRow,
  type SchedulingWeatherCheckRow,
} from '../../../src/core/ai/schedulingAuthoritativeFacts.ts';

type SubjectTable =
  | 'leads'
  | 'customers'
  | 'properties'
  | 'property_measurements'
  | 'photo_analyses'
  | 'price_books'
  | 'estimates'
  | 'estimate_lines'
  | 'quotes'
  | 'jobs'
  | 'visits'
  | 'invoices'
  | 'payments'
  | 'consent_records'
  | 'incidents'
  | 'scheduling_evidence_receipts';

type FactSource = {
  table: Exclude<SubjectTable, 'payments' | 'scheduling_evidence_receipts'>;
  select: string;
  observedAtFields: string[];
};

type ResolutionRequest = Pick<OfficeRunRequest, 'agent' | 'trustedFacts'>;
type Row = Record<string, unknown>;
type SubjectScope = Record<SubjectTable, Set<string>>;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const maximumRowsPerRelationship = 50;
const incompleteRelationshipsByRows = new WeakMap<object, Set<string>>();
const actorIdsByClient = new WeakMap<object, string>();

function actorIdFor(client: SupabaseClient): string {
  const actorId = actorIdsByClient.get(client as unknown as object);
  if (!actorId) {
    throw new Error('Authoritative fact reads require an authenticated actor.');
  }
  return actorId;
}

function incompleteRelationships(rows: Map<SubjectTable, Row[]>): Set<string> {
  const existing = incompleteRelationshipsByRows.get(rows);
  if (existing) return existing;
  const created = new Set<string>();
  incompleteRelationshipsByRows.set(rows, created);
  return created;
}

export class AuthoritativeFactScopeError extends Error {
  readonly code = 'AMBIGUOUS_AI_SUBJECT';

  constructor(message: string) {
    super(message);
    this.name = 'AuthoritativeFactScopeError';
  }
}

/*
 * These are model-facing projections, not generic database projections. In
 * particular they deliberately exclude names, email, phone, street/billing
 * addresses, coordinates, provider IDs, free-form notes, consent proof, and
 * raw provider payloads.
 */
const sources: Readonly<Record<FactSource['table'], FactSource>> = {
  leads: {
    table: 'leads',
    select:
      'id,status,source,customer_id,property_id,requested_services,preferred_contact_channel,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  customers: {
    table: 'customers',
    select: 'id,lifecycle,do_not_contact,tax_exempt,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  properties: {
    table: 'properties',
    select:
      'id,customer_id,property_type,known_hazards,stories,geocode_confidence,last_serviced_at,updated_at,version',
    observedAtFields: ['updated_at', 'last_serviced_at'],
  },
  property_measurements: {
    table: 'property_measurements',
    select:
      'id,property_id,kind,label,value,unit,source,measured_at,confidence,verified_by_human,source_asset_ids,updated_at,version',
    observedAtFields: ['updated_at', 'measured_at'],
  },
  photo_analyses: {
    table: 'photo_analyses',
    select:
      'id,property_id,purpose,overall_confidence,unknowns,disposition,analyzed_at,injection_signals',
    observedAtFields: ['analyzed_at'],
  },
  price_books: {
    table: 'price_books',
    select:
      'id,version_label,status,effective_from,effective_until,company_minimum,default_tax_rate_pct,margin_floor_pct,automatic_discount_limit_pct,deposit_kind,deposit_value,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  estimates: {
    table: 'estimates',
    select:
      'id,estimate_number,customer_id,property_id,lead_id,price_book_id,price_book_version,status,service_subtotal,travel_fee,discount,tax,total,deposit_required,estimated_cost,estimated_margin_pct,duration_minutes,calculation_version,calculation_issues,calculated_at,updated_at,version',
    observedAtFields: ['updated_at', 'calculated_at'],
  },
  estimate_lines: {
    table: 'estimate_lines',
    select:
      'id,estimate_id,line_kind,service_code,add_on_code,description,quantity,unit,unit_price,multiplier,subtotal,taxable,estimated_cost,source_measurement_ids,sort_order,created_at',
    observedAtFields: ['created_at'],
  },
  quotes: {
    table: 'quotes',
    select:
      'id,quote_number,estimate_id,customer_id,property_id,status,valid_until,terms_version,total,deposit_required,sent_at,accepted_at,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  jobs: {
    table: 'jobs',
    select:
      'id,job_number,quote_id,customer_id,property_id,status,priority,service_codes,estimated_duration_minutes,estimated_revenue,estimated_cost,assigned_crew_id,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  visits: {
    table: 'visits',
    select:
      'id,job_id,sequence,status,starts_at,ends_at,crew_id,route_check_id,weather_check_id,updated_at,version',
    observedAtFields: ['updated_at'],
  },
  invoices: {
    table: 'invoices',
    select:
      'id,invoice_number,customer_id,job_id,status,issue_date,due_date,subtotal,tax,total,amount_paid,balance_due,paid_at,updated_at,version',
    observedAtFields: ['updated_at', 'paid_at'],
  },
  consent_records: {
    table: 'consent_records',
    select:
      'id,customer_id,lead_id,channel,purpose,status,captured_at,capture_method,withdrawn_at,updated_at,version',
    observedAtFields: ['updated_at', 'captured_at'],
  },
  incidents: {
    table: 'incidents',
    select:
      'id,job_id,visit_id,property_id,severity,status,category,occurred_at,reported_at,owner_notified_at,requires_legal_review,closed_at,updated_at,version',
    observedAtFields: ['updated_at', 'reported_at'],
  },
};

const aliases: Readonly<Record<string, SubjectTable>> = {
  lead: 'leads',
  leads: 'leads',
  lead_id: 'leads',
  customer: 'customers',
  customers: 'customers',
  customer_id: 'customers',
  property: 'properties',
  properties: 'properties',
  property_id: 'properties',
  property_measurement: 'property_measurements',
  property_measurements: 'property_measurements',
  property_measurement_id: 'property_measurements',
  measurement: 'property_measurements',
  measurement_id: 'property_measurements',
  photo_analysis: 'photo_analyses',
  photo_analyses: 'photo_analyses',
  photo_analysis_id: 'photo_analyses',
  price_book: 'price_books',
  price_books: 'price_books',
  price_book_id: 'price_books',
  estimate: 'estimates',
  estimates: 'estimates',
  estimate_id: 'estimates',
  estimate_line: 'estimate_lines',
  estimate_lines: 'estimate_lines',
  estimate_line_id: 'estimate_lines',
  quote: 'quotes',
  quotes: 'quotes',
  quote_id: 'quotes',
  job: 'jobs',
  jobs: 'jobs',
  job_id: 'jobs',
  visit: 'visits',
  visits: 'visits',
  visit_id: 'visits',
  invoice: 'invoices',
  invoices: 'invoices',
  invoice_id: 'invoices',
  payment: 'payments',
  payments: 'payments',
  payment_id: 'payments',
  consent_record: 'consent_records',
  consent_records: 'consent_records',
  consent_record_id: 'consent_records',
  incident: 'incidents',
  incidents: 'incidents',
  incident_id: 'incidents',
  scheduling_evidence_receipt: 'scheduling_evidence_receipts',
  scheduling_evidence_receipts: 'scheduling_evidence_receipts',
  scheduling_evidence_receipt_id: 'scheduling_evidence_receipts',
};

const allowedTables: Readonly<Record<OfficeAgentName, ReadonlySet<SubjectTable>>> = {
  intake: new Set(['leads', 'customers', 'consent_records']),
  estimating: new Set([
    'leads',
    'properties',
    'property_measurements',
    'photo_analyses',
    'price_books',
    'estimates',
    'estimate_lines',
    'quotes',
  ]),
  scheduling: new Set(['properties', 'jobs', 'visits', 'scheduling_evidence_receipts']),
  follow_up: new Set(['leads', 'customers', 'quotes', 'jobs', 'invoices', 'consent_records']),
  marketing: new Set(['leads', 'customers', 'consent_records']),
  finance: new Set(['customers', 'jobs', 'invoices', 'payments']),
  safety: new Set(['properties', 'photo_analyses', 'jobs', 'visits', 'incidents']),
  owner_briefing: new Set(),
};

const subjectPriority: Readonly<
  Record<Exclude<OfficeAgentName, 'owner_briefing'>, readonly SubjectTable[]>
> = {
  intake: ['leads', 'customers', 'consent_records'],
  estimating: [
    'estimates',
    'properties',
    'leads',
    'quotes',
    'property_measurements',
    'photo_analyses',
    'estimate_lines',
    'price_books',
  ],
  scheduling: ['jobs', 'visits', 'scheduling_evidence_receipts', 'properties'],
  follow_up: ['customers', 'leads', 'quotes', 'jobs', 'invoices', 'consent_records'],
  marketing: ['customers', 'leads', 'consent_records'],
  finance: ['invoices', 'customers', 'jobs', 'payments'],
  safety: ['incidents', 'jobs', 'visits', 'properties', 'photo_analyses'],
};

function emptyScope(): SubjectScope {
  return {
    leads: new Set(),
    customers: new Set(),
    properties: new Set(),
    property_measurements: new Set(),
    photo_analyses: new Set(),
    price_books: new Set(),
    estimates: new Set(),
    estimate_lines: new Set(),
    quotes: new Set(),
    jobs: new Set(),
    visits: new Set(),
    invoices: new Set(),
    payments: new Set(),
    consent_records: new Set(),
    incidents: new Set(),
    scheduling_evidence_receipts: new Set(),
  };
}

function normalizedAlias(value: string): SubjectTable | undefined {
  return aliases[value.trim().toLowerCase().replaceAll('-', '_')];
}

function addSelector(scope: SubjectScope, rawTable: string, rawId: unknown): void {
  const table = normalizedAlias(rawTable);
  if (!table || typeof rawId !== 'string' || !uuidPattern.test(rawId)) return;
  scope[table].add(rawId.toLowerCase());
}

/**
 * Caller-supplied facts are selection hints only. Their values never become
 * authoritative model facts; every selected entity is re-read through the
 * company-scoped service client.
 */
export function extractAuthoritativeSubjectScope(trustedFacts: TrustedFact[]): SubjectScope {
  const scope = emptyScope();
  for (const fact of trustedFacts) {
    const separator = fact.id.indexOf(':');
    if (separator > 0) {
      addSelector(scope, fact.id.slice(0, separator), fact.id.slice(separator + 1));
    }
    addSelector(scope, fact.name, fact.value);
    if (fact.value && typeof fact.value === 'object' && !Array.isArray(fact.value)) {
      for (const [key, value] of Object.entries(fact.value as Record<string, unknown>)) {
        addSelector(scope, key, value);
      }
    }
  }
  return scope;
}

function narrowToOneSubject(
  agent: Exclude<OfficeAgentName, 'owner_briefing'>,
  candidateScope: SubjectScope,
): SubjectScope {
  const narrowed = emptyScope();
  for (const table of subjectPriority[agent]) {
    const candidates = [...candidateScope[table]].sort();
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      throw new AuthoritativeFactScopeError(
        `AI-office ${agent} runs require exactly one ${table} root subject.`,
      );
    }
    /*
     * One run has one root subject. Additional hints are never unioned into
     * model context; related records are discovered only through persisted
     * foreign keys on that root.
     */
    narrowed[table].add(candidates[0]!);
    return narrowed;
  }
  return narrowed;
}

function observedAt(row: Row, fields: string[], fallback: string): string {
  for (const field of fields) {
    if (typeof row[field] === 'string') return row[field] as string;
  }
  return fallback;
}

function idValues(rows: Row[], field: string): string[] {
  return [
    ...new Set(
      rows.flatMap((row) => {
        const value = row[field];
        return typeof value === 'string' && uuidPattern.test(value) ? [value] : [];
      }),
    ),
  ];
}

function mergeRows(target: Map<SubjectTable, Row[]>, table: SubjectTable, rows: Row[]): void {
  const existing = target.get(table) ?? [];
  const byId = new Map<string, Row>();
  for (const row of [...existing, ...rows]) {
    if (typeof row.id === 'string') byId.set(row.id, row);
  }
  target.set(
    table,
    [...byId.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
  );
}

async function queryRows(
  client: SupabaseClient,
  companyId: string,
  table: string,
  select: string,
  field: string,
  values: Iterable<string>,
  limit = maximumRowsPerRelationship,
  incomplete?: Set<string>,
): Promise<Row[]> {
  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length === 0) return [];
  void select;
  const { data, error } = await client.rpc('load_storyops_ai_fact_rows', {
    p_company_id: companyId,
    p_actor_user_id: actorIdFor(client),
    p_table: table,
    p_field: field,
    p_values: uniqueValues,
    p_limit: limit + 1,
  });
  if (error) {
    throw new Error(`Authoritative ${table} facts could not be resolved: ${error.message}`);
  }
  const rows = (data ?? []) as unknown as Row[];
  if (rows.length > limit) incomplete?.add(`${table}.${field}`);
  return rows.slice(0, limit);
}

async function queryActivePriceBook(client: SupabaseClient, companyId: string): Promise<Row[]> {
  const { data, error } = await client.rpc('load_storyops_ai_active_price_book', {
    p_company_id: companyId,
    p_actor_user_id: actorIdFor(client),
  });
  if (error) {
    throw new Error(`Authoritative price_books facts could not be resolved: ${error.message}`);
  }
  return (data ?? []) as unknown as Row[];
}

async function loadSourceBy(
  client: SupabaseClient,
  companyId: string,
  rows: Map<SubjectTable, Row[]>,
  table: FactSource['table'],
  field: string,
  values: Iterable<string>,
): Promise<Row[]> {
  const source = sources[table];
  const loaded = await queryRows(
    client,
    companyId,
    source.table,
    source.select,
    field,
    values,
    maximumRowsPerRelationship,
    incompleteRelationships(rows),
  );
  mergeRows(rows, table, loaded);
  return loaded;
}

function rowsFor(rows: Map<SubjectTable, Row[]>, table: SubjectTable): Row[] {
  return rows.get(table) ?? [];
}

async function resolveIntakeFacts(
  client: SupabaseClient,
  companyId: string,
  scope: SubjectScope,
  rows: Map<SubjectTable, Row[]>,
): Promise<void> {
  const directLeads = await loadSourceBy(client, companyId, rows, 'leads', 'id', scope.leads);
  const directCustomers = await loadSourceBy(
    client,
    companyId,
    rows,
    'customers',
    'id',
    scope.customers,
  );
  if (directCustomers.length > 0) {
    await loadSourceBy(
      client,
      companyId,
      rows,
      'leads',
      'customer_id',
      idValues(directCustomers, 'id'),
    );
  }
  const customerIds = new Set([
    ...idValues(directLeads, 'customer_id'),
    ...idValues(rowsFor(rows, 'leads'), 'customer_id'),
    ...idValues(directCustomers, 'id'),
  ]);
  await loadSourceBy(client, companyId, rows, 'customers', 'id', customerIds);
  await Promise.all([
    loadSourceBy(
      client,
      companyId,
      rows,
      'consent_records',
      'lead_id',
      idValues(rowsFor(rows, 'leads'), 'id'),
    ),
    loadSourceBy(client, companyId, rows, 'consent_records', 'customer_id', customerIds),
    loadSourceBy(client, companyId, rows, 'consent_records', 'id', scope.consent_records),
  ]);
}

async function resolveEstimatingFacts(
  client: SupabaseClient,
  companyId: string,
  scope: SubjectScope,
  rows: Map<SubjectTable, Row[]>,
): Promise<void> {
  await Promise.all([
    loadSourceBy(client, companyId, rows, 'leads', 'id', scope.leads),
    loadSourceBy(client, companyId, rows, 'properties', 'id', scope.properties),
    loadSourceBy(
      client,
      companyId,
      rows,
      'property_measurements',
      'id',
      scope.property_measurements,
    ),
    loadSourceBy(client, companyId, rows, 'photo_analyses', 'id', scope.photo_analyses),
    loadSourceBy(client, companyId, rows, 'estimates', 'id', scope.estimates),
    loadSourceBy(client, companyId, rows, 'estimate_lines', 'id', scope.estimate_lines),
    loadSourceBy(client, companyId, rows, 'quotes', 'id', scope.quotes),
    loadSourceBy(client, companyId, rows, 'price_books', 'id', scope.price_books),
  ]);

  await loadSourceBy(
    client,
    companyId,
    rows,
    'estimates',
    'id',
    idValues(rowsFor(rows, 'estimate_lines'), 'estimate_id'),
  );
  await loadSourceBy(
    client,
    companyId,
    rows,
    'estimates',
    'id',
    idValues(rowsFor(rows, 'quotes'), 'estimate_id'),
  );

  const propertyIds = new Set([
    ...idValues(rowsFor(rows, 'leads'), 'property_id'),
    ...idValues(rowsFor(rows, 'property_measurements'), 'property_id'),
    ...idValues(rowsFor(rows, 'photo_analyses'), 'property_id'),
    ...idValues(rowsFor(rows, 'estimates'), 'property_id'),
    ...idValues(rowsFor(rows, 'quotes'), 'property_id'),
    ...scope.properties,
  ]);
  await loadSourceBy(client, companyId, rows, 'properties', 'id', propertyIds);

  const leadIds = new Set([
    ...idValues(rowsFor(rows, 'leads'), 'id'),
    ...idValues(rowsFor(rows, 'estimates'), 'lead_id'),
  ]);
  await Promise.all([
    loadSourceBy(client, companyId, rows, 'estimates', 'property_id', propertyIds),
    loadSourceBy(client, companyId, rows, 'property_measurements', 'property_id', propertyIds),
    loadSourceBy(client, companyId, rows, 'photo_analyses', 'property_id', propertyIds),
    loadSourceBy(client, companyId, rows, 'estimates', 'lead_id', leadIds),
  ]);

  const estimateIds = idValues(rowsFor(rows, 'estimates'), 'id');
  await Promise.all([
    loadSourceBy(client, companyId, rows, 'estimate_lines', 'estimate_id', estimateIds),
    loadSourceBy(client, companyId, rows, 'quotes', 'estimate_id', estimateIds),
  ]);
  const priceBookIds = idValues(rowsFor(rows, 'estimates'), 'price_book_id');
  await loadSourceBy(client, companyId, rows, 'price_books', 'id', priceBookIds);
  if (rowsFor(rows, 'price_books').length === 0 && propertyIds.size > 0) {
    mergeRows(rows, 'price_books', await queryActivePriceBook(client, companyId));
  }
}

async function resolveSchedulingFacts(
  client: SupabaseClient,
  companyId: string,
  resolvedAt: string,
  jobIds: Iterable<string>,
  receiptIds: Iterable<string>,
  incomplete: Set<string>,
): Promise<{ facts: TrustedFact[]; receipts: Row[] }> {
  const select =
    'id,company_id,job_id,property_id,crew_id,starts_at,ends_at,evidence_mode,capacity_provider,capacity_reference,capacity_disposition,capacity_observed_at,capacity_expires_at,capacity_payload,route_check_id,route_disposition,route_observed_at,route_expires_at,weather_check_id,weather_disposition,weather_observed_at,weather_expires_at,weather_policy_version,unknowns,conflicts,expires_at,created_at';
  const queryReceipts = async (field: 'job_id' | 'id', values: Iterable<string>) => {
    const uniqueValues = [...new Set(values)];
    if (uniqueValues.length === 0) return [] as Row[];
    void select;
    const { data, error } = await client.rpc('load_storyops_ai_scheduling_receipts', {
      p_company_id: companyId,
      p_actor_user_id: actorIdFor(client),
      p_field: field,
      p_values: uniqueValues,
      p_limit: 11,
    });
    if (error) {
      throw new Error(
        `Authoritative scheduling receipt facts could not be resolved: ${error.message}`,
      );
    }
    const rows = (data ?? []) as unknown as Row[];
    if (rows.length > 10) incomplete.add(`scheduling_evidence_receipts.${field}`);
    return rows.slice(0, 10);
  };

  const receiptsById = new Map<string, Row>();
  for (const row of [
    ...(await queryReceipts('job_id', jobIds)),
    ...(await queryReceipts('id', receiptIds)),
  ]) {
    if (typeof row.id === 'string') receiptsById.set(row.id, row);
  }
  const receipts = [...receiptsById.values()];
  if (receipts.length === 0) return { facts: [], receipts: [] };

  const receiptIdsForQuery = idValues(receipts, 'id');
  const consumptions = await queryRows(
    client,
    companyId,
    'scheduling_evidence_consumptions',
    'id,company_id,evidence_receipt_id,visit_id,consumed_at',
    'evidence_receipt_id',
    receiptIdsForQuery,
    10,
    incomplete,
  );
  const consumedReceiptIds = new Set(idValues(consumptions, 'evidence_receipt_id'));
  const eligibleReceipts = receipts.filter(
    (receipt) =>
      typeof receipt.id === 'string' &&
      !consumedReceiptIds.has(receipt.id) &&
      typeof receipt.expires_at === 'string' &&
      Date.parse(receipt.expires_at) > Date.parse(resolvedAt),
  );

  const routeIds = idValues(eligibleReceipts, 'route_check_id');
  const weatherIds = idValues(eligibleReceipts, 'weather_check_id');
  const visitIds = idValues(consumptions, 'visit_id');
  const jobIdsForBooking = idValues(receipts, 'job_id');
  const [routeChecks, weatherChecks, visits, jobs] = await Promise.all([
    queryRows(
      client,
      companyId,
      'route_checks',
      'id,company_id,provider,route_feasible,violations',
      'id',
      routeIds,
      10,
      incomplete,
    ),
    queryRows(
      client,
      companyId,
      'weather_checks',
      'id,company_id,provider,forecast_issued_at,policy_disposition',
      'id',
      weatherIds,
      10,
      incomplete,
    ),
    queryRows(
      client,
      companyId,
      'visits',
      'id,company_id,job_id,crew_id,starts_at,ends_at,status,scheduling_evidence_receipt_id',
      'id',
      visitIds,
      10,
      incomplete,
    ),
    queryRows(
      client,
      companyId,
      'jobs',
      'id,company_id,assigned_crew_id,status',
      'id',
      jobIdsForBooking,
      10,
      incomplete,
    ),
  ]);

  return {
    facts: [
      ...schedulingTrustedFactsFromRows({
        receipts: eligibleReceipts as unknown as SchedulingReceiptRow[],
        routeChecks: routeChecks as unknown as SchedulingRouteCheckRow[],
        weatherChecks: weatherChecks as unknown as SchedulingWeatherCheckRow[],
      }),
      ...schedulingBookingFactsFromRows({
        receipts: receipts as unknown as SchedulingReceiptRow[],
        consumptions: consumptions as unknown as SchedulingConsumptionRow[],
        jobs: jobs as unknown as SchedulingJobRow[],
        visits: visits as unknown as SchedulingVisitRow[],
      }),
    ],
    receipts,
  };
}

async function resolveSchedulingAgentFacts(
  client: SupabaseClient,
  companyId: string,
  resolvedAt: string,
  scope: SubjectScope,
  rows: Map<SubjectTable, Row[]>,
): Promise<TrustedFact[]> {
  await Promise.all([
    loadSourceBy(client, companyId, rows, 'jobs', 'id', scope.jobs),
    loadSourceBy(client, companyId, rows, 'visits', 'id', scope.visits),
    loadSourceBy(client, companyId, rows, 'properties', 'id', scope.properties),
  ]);
  await loadSourceBy(
    client,
    companyId,
    rows,
    'jobs',
    'id',
    idValues(rowsFor(rows, 'visits'), 'job_id'),
  );
  const scheduling = await resolveSchedulingFacts(
    client,
    companyId,
    resolvedAt,
    idValues(rowsFor(rows, 'jobs'), 'id'),
    scope.scheduling_evidence_receipts,
    incompleteRelationships(rows),
  );
  const receiptJobIds = idValues(scheduling.receipts, 'job_id');
  await loadSourceBy(client, companyId, rows, 'jobs', 'id', receiptJobIds);

  const jobIds = idValues(rowsFor(rows, 'jobs'), 'id');
  await loadSourceBy(client, companyId, rows, 'visits', 'job_id', jobIds);
  const propertyIds = new Set([
    ...idValues(rowsFor(rows, 'jobs'), 'property_id'),
    ...idValues(scheduling.receipts, 'property_id'),
  ]);
  await loadSourceBy(client, companyId, rows, 'properties', 'id', propertyIds);
  return scheduling.facts;
}

async function resolveFollowUpFacts(
  client: SupabaseClient,
  companyId: string,
  scope: SubjectScope,
  rows: Map<SubjectTable, Row[]>,
): Promise<void> {
  await Promise.all([
    loadSourceBy(client, companyId, rows, 'leads', 'id', scope.leads),
    loadSourceBy(client, companyId, rows, 'customers', 'id', scope.customers),
    loadSourceBy(client, companyId, rows, 'quotes', 'id', scope.quotes),
    loadSourceBy(client, companyId, rows, 'jobs', 'id', scope.jobs),
    loadSourceBy(client, companyId, rows, 'invoices', 'id', scope.invoices),
    loadSourceBy(client, companyId, rows, 'consent_records', 'id', scope.consent_records),
  ]);
  const customerIds = new Set([
    ...idValues(rowsFor(rows, 'leads'), 'customer_id'),
    ...idValues(rowsFor(rows, 'quotes'), 'customer_id'),
    ...idValues(rowsFor(rows, 'jobs'), 'customer_id'),
    ...idValues(rowsFor(rows, 'invoices'), 'customer_id'),
    ...scope.customers,
  ]);
  await Promise.all([
    loadSourceBy(client, companyId, rows, 'customers', 'id', customerIds),
    loadSourceBy(client, companyId, rows, 'leads', 'customer_id', customerIds),
    loadSourceBy(client, companyId, rows, 'quotes', 'customer_id', customerIds),
    loadSourceBy(client, companyId, rows, 'jobs', 'customer_id', customerIds),
    loadSourceBy(client, companyId, rows, 'invoices', 'customer_id', customerIds),
    loadSourceBy(client, companyId, rows, 'consent_records', 'customer_id', customerIds),
    loadSourceBy(
      client,
      companyId,
      rows,
      'consent_records',
      'lead_id',
      idValues(rowsFor(rows, 'leads'), 'id'),
    ),
  ]);
}

async function resolveFinanceFacts(
  client: SupabaseClient,
  companyId: string,
  scope: SubjectScope,
  rows: Map<SubjectTable, Row[]>,
): Promise<TrustedFact[]> {
  await Promise.all([
    loadSourceBy(client, companyId, rows, 'customers', 'id', scope.customers),
    loadSourceBy(client, companyId, rows, 'jobs', 'id', scope.jobs),
    loadSourceBy(client, companyId, rows, 'invoices', 'id', scope.invoices),
  ]);
  const directPayments = await queryRows(
    client,
    companyId,
    'payments',
    'id,invoice_id,customer_id,payment_type,status,processed_at,updated_at',
    'id',
    scope.payments,
    maximumRowsPerRelationship,
    incompleteRelationships(rows),
  );
  mergeRows(rows, 'payments', directPayments);
  await loadSourceBy(
    client,
    companyId,
    rows,
    'invoices',
    'id',
    idValues(directPayments, 'invoice_id'),
  );
  const customerIds = new Set([
    ...idValues(rowsFor(rows, 'jobs'), 'customer_id'),
    ...idValues(rowsFor(rows, 'invoices'), 'customer_id'),
    ...idValues(directPayments, 'customer_id'),
    ...scope.customers,
  ]);
  await Promise.all([
    loadSourceBy(client, companyId, rows, 'customers', 'id', customerIds),
    loadSourceBy(client, companyId, rows, 'jobs', 'customer_id', customerIds),
    loadSourceBy(client, companyId, rows, 'invoices', 'customer_id', customerIds),
  ]);
  const invoiceIds = idValues(rowsFor(rows, 'invoices'), 'id');
  const relatedPayments = await queryRows(
    client,
    companyId,
    'payments',
    'id,invoice_id,customer_id,payment_type,status,processed_at,updated_at',
    'invoice_id',
    invoiceIds,
    maximumRowsPerRelationship,
    incompleteRelationships(rows),
  );
  mergeRows(rows, 'payments', relatedPayments);

  const paymentFacts: TrustedFact[] = [];
  for (const invoiceId of invoiceIds) {
    const payments = rowsFor(rows, 'payments').filter(
      (payment) => payment.invoice_id === invoiceId,
    );
    if (payments.length === 0) continue;
    const statusCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};
    let observed = '';
    for (const payment of payments) {
      const status = typeof payment.status === 'string' ? payment.status : 'unknown';
      const paymentType =
        typeof payment.payment_type === 'string' ? payment.payment_type : 'unknown';
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      typeCounts[paymentType] = (typeCounts[paymentType] ?? 0) + 1;
      const candidate =
        typeof payment.updated_at === 'string'
          ? payment.updated_at
          : typeof payment.processed_at === 'string'
            ? payment.processed_at
            : '';
      if (candidate > observed) observed = candidate;
    }
    paymentFacts.push({
      id: `payment_summary:invoice:${invoiceId}`,
      name: 'payment_summary',
      value: {
        invoiceId,
        recordCount: payments.length,
        statusCounts,
        typeCounts,
      },
      source: 'deterministic_calculation',
      observedAt: observed || new Date(0).toISOString(),
    });
  }
  return paymentFacts;
}

async function resolveSafetyFacts(
  client: SupabaseClient,
  companyId: string,
  scope: SubjectScope,
  rows: Map<SubjectTable, Row[]>,
): Promise<void> {
  await Promise.all([
    loadSourceBy(client, companyId, rows, 'properties', 'id', scope.properties),
    loadSourceBy(client, companyId, rows, 'photo_analyses', 'id', scope.photo_analyses),
    loadSourceBy(client, companyId, rows, 'jobs', 'id', scope.jobs),
    loadSourceBy(client, companyId, rows, 'visits', 'id', scope.visits),
    loadSourceBy(client, companyId, rows, 'incidents', 'id', scope.incidents),
  ]);
  await Promise.all([
    loadSourceBy(
      client,
      companyId,
      rows,
      'jobs',
      'id',
      idValues(rowsFor(rows, 'visits'), 'job_id'),
    ),
    loadSourceBy(
      client,
      companyId,
      rows,
      'jobs',
      'id',
      idValues(rowsFor(rows, 'incidents'), 'job_id'),
    ),
  ]);
  const propertyIds = new Set([
    ...idValues(rowsFor(rows, 'jobs'), 'property_id'),
    ...idValues(rowsFor(rows, 'photo_analyses'), 'property_id'),
    ...idValues(rowsFor(rows, 'incidents'), 'property_id'),
    ...scope.properties,
  ]);
  const jobIds = idValues(rowsFor(rows, 'jobs'), 'id');
  await Promise.all([
    loadSourceBy(client, companyId, rows, 'properties', 'id', propertyIds),
    loadSourceBy(client, companyId, rows, 'photo_analyses', 'property_id', propertyIds),
    loadSourceBy(client, companyId, rows, 'visits', 'job_id', jobIds),
    loadSourceBy(client, companyId, rows, 'incidents', 'job_id', jobIds),
    loadSourceBy(client, companyId, rows, 'incidents', 'property_id', propertyIds),
  ]);
}

function countStatuses(rows: Row[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const status = typeof row.status === 'string' ? row.status : 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

async function resolveOwnerBriefingFacts(
  client: SupabaseClient,
  companyId: string,
  resolvedAt: string,
): Promise<TrustedFact[]> {
  const aggregateRowLimit = 1_000;
  const { data, error } = await client.rpc('load_storyops_ai_owner_briefing_rows', {
    p_company_id: companyId,
    p_actor_user_id: actorIdFor(client),
  });
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(
      `Authoritative owner briefing facts could not be resolved: ${error?.message ?? 'invalid response'}`,
    );
  }
  const aggregate = data as unknown as Record<string, unknown>;
  const aggregateResult = (key: string): { rows: Row[]; complete: boolean } => {
    const value = aggregate[key];
    if (!Array.isArray(value)) {
      throw new Error(`Authoritative owner briefing ${key} rows were invalid.`);
    }
    const rows = value as Row[];
    return {
      rows: rows.slice(0, aggregateRowLimit),
      complete: rows.length <= aggregateRowLimit,
    };
  };
  const leadResult = aggregateResult('leads');
  const jobResult = aggregateResult('jobs');
  const invoiceResult = aggregateResult('invoices');
  const approvalResult = aggregateResult('approvals');
  const leads = leadResult.rows;
  const jobs = jobResult.rows;
  const invoices = invoiceResult.rows;
  const approvals = approvalResult.rows;
  const openBalanceCents = invoices.reduce((total, invoice) => {
    const value =
      typeof invoice.balance_due === 'number'
        ? invoice.balance_due
        : typeof invoice.balance_due === 'string'
          ? Number(invoice.balance_due)
          : 0;
    return Number.isFinite(value) ? total + Math.round(value * 100) : total;
  }, 0);
  const overdueOpenInvoices = invoices.filter(
    (invoice) =>
      invoice.status === 'past_due' ||
      (invoice.status === 'open' &&
        typeof invoice.due_date === 'string' &&
        invoice.due_date < resolvedAt.slice(0, 10)),
  ).length;
  const pendingApprovalsByRisk: Record<string, number> = {};
  for (const approval of approvals) {
    if (approval.status !== 'pending') continue;
    const risk = typeof approval.risk_level === 'string' ? approval.risk_level : 'unknown';
    pendingApprovalsByRisk[risk] = (pendingApprovalsByRisk[risk] ?? 0) + 1;
  }
  const completeness = {
    leads: leadResult.complete,
    jobs: jobResult.complete,
    invoices: invoiceResult.complete,
    approvals: approvalResult.complete,
  };
  const unknowns = Object.entries(completeness)
    .filter(([, complete]) => !complete)
    .map(
      ([table]) =>
        `${table} exceeded the ${aggregateRowLimit}-row briefing boundary; its aggregate is incomplete.`,
    );
  return [
    {
      id: `owner_briefing_summary:${resolvedAt.slice(0, 13)}`,
      name: 'owner_briefing_summary',
      value: {
        leadStatusCounts: countStatuses(leads),
        jobStatusCounts: countStatuses(jobs),
        invoiceStatusCounts: countStatuses(invoices),
        invoiceOpenBalance: (openBalanceCents / 100).toFixed(2),
        overdueOpenInvoiceCount: overdueOpenInvoices,
        pendingApprovalsByRisk,
        aggregationComplete: unknowns.length === 0,
        completeness,
        unknowns,
      },
      source: 'deterministic_calculation',
      observedAt: resolvedAt,
    },
  ];
}

function factsFromRows(
  rows: Map<SubjectTable, Row[]>,
  agent: OfficeAgentName,
  resolvedAt: string,
): TrustedFact[] {
  const facts: TrustedFact[] = [];
  for (const table of allowedTables[agent]) {
    if (table === 'payments' || table === 'scheduling_evidence_receipts') continue;
    const source = sources[table];
    for (const row of rowsFor(rows, table)) {
      const id = typeof row.id === 'string' ? row.id : undefined;
      if (!id) throw new Error(`Authoritative ${table} fact has no stable ID.`);
      facts.push({
        id: `${table}:${id}`,
        name: table,
        value: row,
        source: 'database',
        observedAt: observedAt(row, source.observedAtFields, resolvedAt),
      });
    }
  }
  return facts;
}

function scopeSummaryFact(
  agent: OfficeAgentName,
  scope: SubjectScope,
  rows: Map<SubjectTable, Row[]>,
  resolvedAt: string,
): TrustedFact {
  const selectorCount = Object.values(scope).reduce((total, ids) => total + ids.size, 0);
  const truncatedRelationships = [...incompleteRelationships(rows)].sort();
  return {
    id: `authoritative_scope:${agent}`,
    name: 'authoritative_scope',
    value: {
      specialist: agent,
      selectorCount,
      resolvedFactCounts: Object.fromEntries(
        [...allowedTables[agent]]
          .filter((table) => table !== 'payments' && table !== 'scheduling_evidence_receipts')
          .map((table) => [table, rowsFor(rows, table).length]),
      ),
      subjectResolved: [...allowedTables[agent]].some((table) => rowsFor(rows, table).length > 0),
      relationshipFactsComplete: truncatedRelationships.length === 0,
      truncatedRelationships,
      unknowns: truncatedRelationships.map(
        (relationship) =>
          `${relationship} exceeded its bounded authoritative-fact relationship limit.`,
      ),
    },
    source: 'deterministic_calculation',
    observedAt: resolvedAt,
  };
}

export async function resolveAuthoritativeFacts(
  client: SupabaseClient,
  companyId: string,
  request: ResolutionRequest,
  actorUserId: string,
): Promise<TrustedFact[]> {
  actorIdsByClient.set(client as unknown as object, actorUserId);
  const resolvedAt = new Date().toISOString();
  if (request.agent === 'owner_briefing') {
    return resolveOwnerBriefingFacts(client, companyId, resolvedAt);
  }

  const scope = narrowToOneSubject(
    request.agent,
    extractAuthoritativeSubjectScope(request.trustedFacts),
  );
  const rows = new Map<SubjectTable, Row[]>();
  let additionalFacts: TrustedFact[] = [];

  switch (request.agent) {
    case 'intake':
    case 'marketing':
      await resolveIntakeFacts(client, companyId, scope, rows);
      break;
    case 'estimating':
      await resolveEstimatingFacts(client, companyId, scope, rows);
      break;
    case 'scheduling':
      additionalFacts = await resolveSchedulingAgentFacts(
        client,
        companyId,
        resolvedAt,
        scope,
        rows,
      );
      break;
    case 'follow_up':
      await resolveFollowUpFacts(client, companyId, scope, rows);
      break;
    case 'finance':
      additionalFacts = await resolveFinanceFacts(client, companyId, scope, rows);
      break;
    case 'safety':
      await resolveSafetyFacts(client, companyId, scope, rows);
      break;
    default: {
      const exhaustive: never = request.agent;
      throw new Error(`Unsupported AI-office specialist: ${String(exhaustive)}`);
    }
  }

  return [
    scopeSummaryFact(request.agent, scope, rows, resolvedAt),
    ...factsFromRows(rows, request.agent, resolvedAt),
    ...additionalFacts,
  ];
}
