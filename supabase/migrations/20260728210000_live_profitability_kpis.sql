-- Server-authoritative profitability and receivables read model.
--
-- Estimated job costs remain deterministic estimate snapshots. Actual costs are
-- never inferred from elapsed time, material quantities, invoice status, or a
-- price book. A trusted finance/import boundary may instead publish one
-- verified actual-cost snapshot per job. Until every direct-cost category is
-- explicitly complete, actual gross profit and margin remain null.

create unique index if not exists jobs_company_id_id_unique
  on public.jobs(company_id, id);

create table public.job_actual_cost_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id uuid not null,
  actual_material_cost numeric(12,2)
    check (actual_material_cost is null or actual_material_cost >= 0),
  actual_labor_cost numeric(12,2)
    check (actual_labor_cost is null or actual_labor_cost >= 0),
  actual_other_direct_cost numeric(12,2)
    check (actual_other_direct_cost is null or actual_other_direct_cost >= 0),
  material_cost_complete boolean not null default false,
  labor_cost_complete boolean not null default false,
  other_direct_cost_complete boolean not null default false,
  source_record_ids uuid[] not null default '{}',
  as_of timestamptz not null,
  verified_at timestamptz not null,
  verified_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (company_id, job_id),
  foreign key (company_id, job_id)
    references public.jobs(company_id, id) on delete cascade,
  check (not material_cost_complete or actual_material_cost is not null),
  check (not labor_cost_complete or actual_labor_cost is not null),
  check (not other_direct_cost_complete or actual_other_direct_cost is not null),
  check (cardinality(source_record_ids) between 1 and 50),
  check (verified_at >= as_of)
);

comment on table public.job_actual_cost_snapshots is
  'Trusted, explicit actual direct-cost facts. Missing values and incomplete flags must remain unknown; time/material quantities are never converted to cost by this table or KPI read model.';

alter table public.job_actual_cost_snapshots enable row level security;
alter table public.job_actual_cost_snapshots force row level security;

create policy job_actual_cost_snapshots_finance_select
  on public.job_actual_cost_snapshots
  for select
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  );

revoke all on table public.job_actual_cost_snapshots
  from public, anon, authenticated;
grant select on table public.job_actual_cost_snapshots to authenticated;
grant select, insert, update on table public.job_actual_cost_snapshots
  to service_role;

create trigger job_actual_cost_snapshots_audit
  after insert or update or delete on public.job_actual_cost_snapshots
  for each row execute function public.audit_mutation();

-- Return the part of an invoice's recorded paid amount that has complete,
-- independently matched Stripe webhook evidence. This is deliberately private:
-- callers receive only tenant-scoped aggregates through the KPI RPC.
create or replace function public.storyops_provider_verified_invoice_paid(
  p_invoice_id uuid
)
returns numeric
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with invoice_fact as (
    select
      invoice.id,
      invoice.company_id,
      invoice.job_id,
      invoice.provider_invoice_id,
      invoice.total,
      invoice.amount_paid,
      invoice.balance_due,
      job.quote_id
    from public.invoices invoice
    join public.jobs job
      on job.id = invoice.job_id
      and job.company_id = invoice.company_id
    where invoice.id = p_invoice_id
  ),
  exact_invoice_proof as (
    select exists (
      select 1
      from invoice_fact invoice
      join public.webhook_events event
        on event.company_id = invoice.company_id
      where event.provider = 'stripe'
        and event.status = 'processed'
        and event.payload ->> 'action' = 'invoice_paid'
        and event.payload ->> 'jobId' = invoice.job_id::text
        and event.payload ->> 'objectId' = invoice.provider_invoice_id
        and event.payload ->> 'amountCents' ~ '^[0-9]+$'
        and event.payload ->> 'amountPaidCents' ~ '^[0-9]+$'
        and event.payload ->> 'amountRemainingCents' ~ '^[0-9]+$'
        and (event.payload ->> 'amountCents')::numeric
          = round(invoice.total * 100)
        and (event.payload ->> 'amountPaidCents')::numeric
          = round(invoice.amount_paid * 100)
        and (event.payload ->> 'amountRemainingCents')::numeric
          = round(invoice.balance_due * 100)
    ) as proven
  ),
  matched_payment_facts as (
    select
      payment.id,
      payment.invoice_id,
      case
        when payment.payment_type = 'refund' then -payment.amount
        else payment.amount
      end as signed_amount
    from invoice_fact invoice
    join public.payments payment
      on payment.invoice_id = invoice.id
      and payment.company_id = invoice.company_id
      and payment.provider = 'stripe'
      and payment.processed_at is not null
      and payment.provider_payment_id is not null
    where (
      payment.payment_type <> 'refund'
      and payment.status in ('succeeded', 'partially_refunded', 'refunded')
      and exists (
        select 1
        from public.webhook_events event
        where event.company_id = invoice.company_id
          and event.provider = 'stripe'
          and event.status = 'processed'
          and event.payload ->> 'action' = 'payment_succeeded'
          and event.payload ->> 'quoteId' = invoice.quote_id::text
          and event.payload ->> 'amountCents' ~ '^[0-9]+$'
          and (event.payload ->> 'amountCents')::numeric
            = round(payment.amount * 100)
          and (
            event.payload ->> 'objectId' = payment.provider_payment_id
            or event.payload ->> 'paymentIntentId' = payment.provider_payment_id
          )
      )
    ) or (
      payment.payment_type = 'refund'
      and payment.status = 'succeeded'
      and exists (
        select 1
        from public.webhook_events event
        where event.company_id = invoice.company_id
          and event.provider = 'stripe'
          and event.status = 'processed'
          and event.payload ->> 'action' = 'refund_succeeded'
          and event.payload ->> 'objectId' = payment.provider_payment_id
          and event.payload ->> 'amountCents' ~ '^[0-9]+$'
          and (event.payload ->> 'amountCents')::numeric
            = round(payment.amount * 100)
          and (
            payment.approval_request_id is null
            or event.payload ->> 'approvalId' = payment.approval_request_id::text
          )
      )
    )
  ),
  matched_payment_total as (
    select coalesce(sum(fact.signed_amount), 0)::numeric as amount
    from matched_payment_facts fact
  )
  select case
    when invoice.amount_paid = 0 then 0::numeric
    when proof.proven then invoice.amount_paid
    when matched.amount = invoice.amount_paid then invoice.amount_paid
    else 0::numeric
  end
  from invoice_fact invoice
  cross join exact_invoice_proof proof
  cross join matched_payment_total matched;
$$;

revoke all on function public.storyops_provider_verified_invoice_paid(uuid)
  from public, anon, authenticated, service_role;

comment on function public.storyops_provider_verified_invoice_paid(uuid) is
  'Private helper that returns recorded paid dollars only when exact processed Stripe webhook evidence reconciles to the invoice ledger.';

create or replace function public.get_storyops_profitability_kpis(
  p_company_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  as_of_value timestamptz := statement_timestamp();
  company_currency text;
  eligible_job_count integer := 0;
  completed_job_count integer := 0;
  invoiced_status_job_count integer := 0;
  profitability_job_count integer := 0;
  jobs_without_invoice_count integer := 0;
  estimated_cost_eligible numeric := 0;
  estimated_cost_invoiced numeric := 0;
  invoiced_subtotal numeric := 0;
  invoiced_tax numeric := 0;
  invoiced_total numeric := 0;
  recorded_paid numeric := 0;
  provider_verified_paid numeric := 0;
  open_receivables numeric := 0;
  past_due_receivables numeric := 0;
  uncollectible_balance numeric := 0;
  pending_payment_amount numeric := 0;
  pending_refund_amount numeric := 0;
  open_invoice_count integer := 0;
  past_due_invoice_count integer := 0;
  paid_invoice_count integer := 0;
  uncollectible_invoice_count integer := 0;
  invoice_ledger_complete boolean := true;
  payment_evidence_complete boolean := true;
  payment_evidence_gap_count integer := 0;
  cost_snapshot_count integer := 0;
  material_cost_available_count integer := 0;
  labor_cost_available_count integer := 0;
  other_cost_available_count integer := 0;
  material_cost_complete_count integer := 0;
  labor_cost_complete_count integer := 0;
  other_cost_complete_count integer := 0;
  actual_cost_complete_job_count integer := 0;
  recorded_actual_material numeric;
  recorded_actual_labor numeric;
  recorded_actual_other numeric;
  actual_cost_complete boolean := true;
  actual_total numeric;
  estimated_gross_profit numeric;
  estimated_gross_margin numeric;
  actual_gross_profit numeric;
  actual_gross_margin numeric;
  latest_actual_cost_as_of timestamptz;
  source_job_ids uuid[] := array[]::uuid[];
  source_invoice_ids uuid[] := array[]::uuid[];
  source_cost_snapshot_ids uuid[] := array[]::uuid[];
  source_payment_ids uuid[] := array[]::uuid[];
  source_provider_event_ids uuid[] := array[]::uuid[];
  source_job_count integer := 0;
  source_invoice_count integer := 0;
  source_cost_snapshot_count integer := 0;
  source_payment_count integer := 0;
  source_provider_event_count integer := 0;
  source_id_list_complete boolean := true;
  unknowns text[] := array[]::text[];
  result jsonb;
  source_fingerprint text;
begin
  if actor_user_id is null then
    raise exception 'Authentication is required';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;

  if actor_role is null or actor_role not in ('owner', 'dispatcher') then
    raise exception 'Profitability KPIs require active owner or dispatcher membership';
  end if;

  select company.currency
  into company_currency
  from public.companies company
  where company.id = p_company_id;

  if company_currency is null then
    raise exception 'Company was not found';
  end if;

  select
    count(*)::integer,
    count(*) filter (where job.status = 'completed')::integer,
    count(*) filter (where job.status = 'invoiced')::integer,
    coalesce(sum(job.estimated_cost), 0)
  into
    eligible_job_count,
    completed_job_count,
    invoiced_status_job_count,
    estimated_cost_eligible
  from public.jobs job
  where job.company_id = p_company_id
    and job.status in ('completed', 'invoiced');

  select
    count(*)::integer,
    coalesce(sum(job.estimated_cost), 0),
    coalesce(sum(invoice.subtotal), 0),
    coalesce(sum(invoice.tax), 0),
    coalesce(sum(invoice.total), 0),
    coalesce(sum(invoice.amount_paid), 0),
    coalesce(sum(
      public.storyops_provider_verified_invoice_paid(invoice.id)
    ), 0),
    coalesce(sum(invoice.balance_due) filter (
      where invoice.status in ('open', 'past_due')
    ), 0),
    coalesce(sum(invoice.balance_due) filter (
      where invoice.status = 'past_due'
    ), 0),
    coalesce(sum(invoice.balance_due) filter (
      where invoice.status = 'uncollectible'
    ), 0),
    count(*) filter (where invoice.status = 'open')::integer,
    count(*) filter (where invoice.status = 'past_due')::integer,
    count(*) filter (where invoice.status = 'paid')::integer,
    count(*) filter (where invoice.status = 'uncollectible')::integer,
    not coalesce(bool_or(
      invoice.total <> invoice.amount_paid + invoice.balance_due
      or (invoice.status = 'paid' and invoice.balance_due <> 0)
      or (invoice.status in ('open', 'past_due') and invoice.balance_due = 0)
    ), false),
    count(*) filter (
      where invoice.amount_paid
        <> public.storyops_provider_verified_invoice_paid(invoice.id)
    )::integer
  into
    profitability_job_count,
    estimated_cost_invoiced,
    invoiced_subtotal,
    invoiced_tax,
    invoiced_total,
    recorded_paid,
    provider_verified_paid,
    open_receivables,
    past_due_receivables,
    uncollectible_balance,
    open_invoice_count,
    past_due_invoice_count,
    paid_invoice_count,
    uncollectible_invoice_count,
    invoice_ledger_complete,
    payment_evidence_gap_count
  from public.jobs job
  join public.invoices invoice
    on invoice.job_id = job.id
    and invoice.company_id = job.company_id
    and invoice.purpose = 'job'
    and invoice.status not in ('draft', 'void')
  where job.company_id = p_company_id
    and job.status in ('completed', 'invoiced');

  jobs_without_invoice_count := eligible_job_count - profitability_job_count;
  payment_evidence_complete := payment_evidence_gap_count = 0;

  select
    coalesce(sum(payment.amount) filter (
      where payment.payment_type <> 'refund'
    ), 0),
    coalesce(sum(payment.amount) filter (
      where payment.payment_type = 'refund'
    ), 0)
  into pending_payment_amount, pending_refund_amount
  from public.payments payment
  join public.invoices invoice
    on invoice.id = payment.invoice_id
    and invoice.company_id = payment.company_id
    and invoice.purpose = 'job'
    and invoice.status not in ('draft', 'void')
  join public.jobs job
    on job.id = invoice.job_id
    and job.company_id = invoice.company_id
  where job.company_id = p_company_id
    and job.status in ('completed', 'invoiced')
    and payment.status = 'pending';

  select
    count(snapshot.id)::integer,
    count(snapshot.actual_material_cost)::integer,
    count(snapshot.actual_labor_cost)::integer,
    count(snapshot.actual_other_direct_cost)::integer,
    count(*) filter (where snapshot.material_cost_complete)::integer,
    count(*) filter (where snapshot.labor_cost_complete)::integer,
    count(*) filter (where snapshot.other_direct_cost_complete)::integer,
    count(*) filter (
      where snapshot.material_cost_complete
        and snapshot.labor_cost_complete
        and snapshot.other_direct_cost_complete
    )::integer,
    sum(snapshot.actual_material_cost),
    sum(snapshot.actual_labor_cost),
    sum(snapshot.actual_other_direct_cost),
    max(snapshot.as_of)
  into
    cost_snapshot_count,
    material_cost_available_count,
    labor_cost_available_count,
    other_cost_available_count,
    material_cost_complete_count,
    labor_cost_complete_count,
    other_cost_complete_count,
    actual_cost_complete_job_count,
    recorded_actual_material,
    recorded_actual_labor,
    recorded_actual_other,
    latest_actual_cost_as_of
  from public.jobs job
  join public.invoices invoice
    on invoice.job_id = job.id
    and invoice.company_id = job.company_id
    and invoice.purpose = 'job'
    and invoice.status not in ('draft', 'void')
  left join public.job_actual_cost_snapshots snapshot
    on snapshot.company_id = job.company_id
    and snapshot.job_id = job.id
    and snapshot.as_of <= as_of_value
    and snapshot.verified_at <= as_of_value
  where job.company_id = p_company_id
    and job.status in ('completed', 'invoiced');

  actual_cost_complete :=
    material_cost_complete_count = profitability_job_count
    and labor_cost_complete_count = profitability_job_count
    and other_cost_complete_count = profitability_job_count;

  if profitability_job_count > 0 then
    estimated_gross_profit := round(invoiced_subtotal - estimated_cost_invoiced, 2);
    if invoiced_subtotal <> 0 then
      estimated_gross_margin := round(
        estimated_gross_profit / invoiced_subtotal * 100,
        4
      );
    end if;
  end if;

  if profitability_job_count > 0 and actual_cost_complete then
    actual_total := round(
      coalesce(recorded_actual_material, 0)
        + coalesce(recorded_actual_labor, 0)
        + coalesce(recorded_actual_other, 0),
      2
    );
    actual_gross_profit := round(invoiced_subtotal - actual_total, 2);
    if invoiced_subtotal <> 0 then
      actual_gross_margin := round(
        actual_gross_profit / invoiced_subtotal * 100,
        4
      );
    end if;
  end if;

  if jobs_without_invoice_count > 0 then
    unknowns := array_append(
      unknowns,
      format(
        '%s completed/invoiced job(s) do not have a non-draft, non-void job invoice; they are excluded from revenue and margin.',
        jobs_without_invoice_count
      )
    );
  end if;
  if profitability_job_count > 0 and invoiced_subtotal = 0 then
    unknowns := array_append(
      unknowns,
      'Gross-margin percentages are undefined because recognized invoice revenue is zero.'
    );
  end if;
  if material_cost_complete_count < profitability_job_count then
    unknowns := array_append(
      unknowns,
      format(
        'Actual material cost is incomplete for %s invoiced job(s); no material cost is inferred from usage quantities.',
        profitability_job_count - material_cost_complete_count
      )
    );
  end if;
  if labor_cost_complete_count < profitability_job_count then
    unknowns := array_append(
      unknowns,
      format(
        'Actual labor cost is incomplete for %s invoiced job(s); no labor cost is inferred from time entries.',
        profitability_job_count - labor_cost_complete_count
      )
    );
  end if;
  if other_cost_complete_count < profitability_job_count then
    unknowns := array_append(
      unknowns,
      format(
        'Other direct costs are incomplete for %s invoiced job(s); actual gross profit remains unavailable.',
        profitability_job_count - other_cost_complete_count
      )
    );
  end if;
  if not invoice_ledger_complete then
    unknowns := array_append(
      unknowns,
      'At least one invoice ledger invariant is inconsistent; receivables require reconciliation.'
    );
  end if;
  if payment_evidence_gap_count > 0 then
    unknowns := array_append(
      unknowns,
      format(
        '%s invoice(s) have recorded paid dollars not fully matched to processed Stripe evidence; recorded and provider-verified paid totals remain separate.',
        payment_evidence_gap_count
      )
    );
  end if;

  select
    coalesce(array(
      select job.id
      from public.jobs job
      where job.company_id = p_company_id
        and job.status in ('completed', 'invoiced')
      order by job.id
      limit 100
    ), '{}'),
    count(*)::integer
  into source_job_ids, source_job_count
  from public.jobs job
  where job.company_id = p_company_id
    and job.status in ('completed', 'invoiced');

  select
    coalesce(array(
      select invoice.id
      from public.invoices invoice
      join public.jobs job
        on job.id = invoice.job_id
        and job.company_id = invoice.company_id
      where job.company_id = p_company_id
        and job.status in ('completed', 'invoiced')
        and invoice.purpose = 'job'
        and invoice.status not in ('draft', 'void')
      order by invoice.id
      limit 100
    ), '{}'),
    count(*)::integer
  into source_invoice_ids, source_invoice_count
  from public.invoices invoice
  join public.jobs job
    on job.id = invoice.job_id
    and job.company_id = invoice.company_id
  where job.company_id = p_company_id
    and job.status in ('completed', 'invoiced')
    and invoice.purpose = 'job'
    and invoice.status not in ('draft', 'void');

  select
    coalesce(array(
      select snapshot.id
      from public.job_actual_cost_snapshots snapshot
      join public.jobs job
        on job.id = snapshot.job_id
        and job.company_id = snapshot.company_id
      join public.invoices invoice
        on invoice.job_id = job.id
        and invoice.company_id = job.company_id
        and invoice.purpose = 'job'
        and invoice.status not in ('draft', 'void')
      where job.company_id = p_company_id
        and job.status in ('completed', 'invoiced')
        and snapshot.as_of <= as_of_value
        and snapshot.verified_at <= as_of_value
      order by snapshot.id
      limit 100
    ), '{}'),
    count(*)::integer
  into source_cost_snapshot_ids, source_cost_snapshot_count
  from public.job_actual_cost_snapshots snapshot
  join public.jobs job
    on job.id = snapshot.job_id
    and job.company_id = snapshot.company_id
  join public.invoices invoice
    on invoice.job_id = job.id
    and invoice.company_id = job.company_id
    and invoice.purpose = 'job'
    and invoice.status not in ('draft', 'void')
  where job.company_id = p_company_id
    and job.status in ('completed', 'invoiced')
    and snapshot.as_of <= as_of_value
    and snapshot.verified_at <= as_of_value;

  select
    coalesce(array(
      select payment.id
      from public.payments payment
      join public.invoices invoice
        on invoice.id = payment.invoice_id
        and invoice.company_id = payment.company_id
      join public.jobs job
        on job.id = invoice.job_id
        and job.company_id = invoice.company_id
      where job.company_id = p_company_id
        and job.status in ('completed', 'invoiced')
        and invoice.purpose = 'job'
        and invoice.status not in ('draft', 'void')
      order by payment.id
      limit 100
    ), '{}'),
    count(*)::integer
  into source_payment_ids, source_payment_count
  from public.payments payment
  join public.invoices invoice
    on invoice.id = payment.invoice_id
    and invoice.company_id = payment.company_id
  join public.jobs job
    on job.id = invoice.job_id
    and job.company_id = invoice.company_id
  where job.company_id = p_company_id
    and job.status in ('completed', 'invoiced')
    and invoice.purpose = 'job'
    and invoice.status not in ('draft', 'void');

  select
    coalesce(array(
      select distinct event.id
      from public.webhook_events event
      join public.jobs job
        on job.company_id = event.company_id
        and (
          event.payload ->> 'jobId' = job.id::text
          or event.payload ->> 'quoteId' = job.quote_id::text
          or exists (
            select 1
            from public.invoices source_invoice
            join public.payments source_payment
              on source_payment.invoice_id = source_invoice.id
              and source_payment.company_id = source_invoice.company_id
            where source_invoice.company_id = job.company_id
              and source_invoice.job_id = job.id
              and (
                event.payload ->> 'objectId'
                  = source_payment.provider_payment_id
                or event.payload ->> 'paymentIntentId'
                  = source_payment.provider_payment_id
                or (
                  source_payment.approval_request_id is not null
                  and event.payload ->> 'approvalId'
                    = source_payment.approval_request_id::text
                )
              )
          )
        )
      where job.company_id = p_company_id
        and job.status in ('completed', 'invoiced')
        and event.provider = 'stripe'
        and event.status = 'processed'
        and event.payload ->> 'action' in (
          'payment_succeeded', 'invoice_paid', 'refund_succeeded'
        )
      order by event.id
      limit 100
    ), '{}'),
    count(distinct event.id)::integer
  into source_provider_event_ids, source_provider_event_count
  from public.webhook_events event
  join public.jobs job
    on job.company_id = event.company_id
    and (
      event.payload ->> 'jobId' = job.id::text
      or event.payload ->> 'quoteId' = job.quote_id::text
      or exists (
        select 1
        from public.invoices source_invoice
        join public.payments source_payment
          on source_payment.invoice_id = source_invoice.id
          and source_payment.company_id = source_invoice.company_id
        where source_invoice.company_id = job.company_id
          and source_invoice.job_id = job.id
          and (
            event.payload ->> 'objectId'
              = source_payment.provider_payment_id
            or event.payload ->> 'paymentIntentId'
              = source_payment.provider_payment_id
            or (
              source_payment.approval_request_id is not null
              and event.payload ->> 'approvalId'
                = source_payment.approval_request_id::text
            )
          )
      )
    )
  where job.company_id = p_company_id
    and job.status in ('completed', 'invoiced')
    and event.provider = 'stripe'
    and event.status = 'processed'
    and event.payload ->> 'action' in (
      'payment_succeeded', 'invoice_paid', 'refund_succeeded'
    );

  source_id_list_complete :=
    source_job_count <= 100
    and source_invoice_count <= 100
    and source_cost_snapshot_count <= 100
    and source_payment_count <= 100
    and source_provider_event_count <= 100;

  if not source_id_list_complete then
    unknowns := array_append(
      unknowns,
      'One or more source-ID lists were capped at 100 records; aggregate amounts and source counts remain exact.'
    );
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-profitability-kpis-v1',
    'companyId', p_company_id,
    'currency', company_currency,
    'asOf', as_of_value,
    'period', jsonb_build_object(
      'kind', 'all_recorded_history',
      'startsAt', null,
      'endsAt', as_of_value
    ),
    'scope', jsonb_build_object(
      'jobStatuses', jsonb_build_array('completed', 'invoiced'),
      'recognizedInvoiceStatuses',
        jsonb_build_array('open', 'paid', 'past_due', 'uncollectible'),
      'revenueBasis', 'invoice_subtotal_excluding_tax',
      'estimatedCostBasis', 'job_estimated_cost_snapshot',
      'actualCostBasis', 'explicit_verified_job_actual_cost_snapshot',
      'paymentBasis', 'invoice_ledger_and_exact_processed_provider_evidence'
    ),
    'jobs', jsonb_build_object(
      'eligibleCount', eligible_job_count,
      'completedCount', completed_job_count,
      'invoicedStatusCount', invoiced_status_job_count,
      'profitabilityCount', profitability_job_count,
      'withoutRecognizedInvoiceCount', jobs_without_invoice_count
    ),
    'revenue', jsonb_build_object(
      'invoicedSubtotal', round(invoiced_subtotal, 2)::text,
      'invoicedTax', round(invoiced_tax, 2)::text,
      'invoicedTotal', round(invoiced_total, 2)::text
    ),
    'costs', jsonb_build_object(
      'estimatedEligibleJobs', round(estimated_cost_eligible, 2)::text,
      'estimatedInvoicedJobs', round(estimated_cost_invoiced, 2)::text,
      'recordedActualMaterial',
        case when material_cost_available_count = 0
          then null
          else round(recorded_actual_material, 2)::text
        end,
      'recordedActualLabor',
        case when labor_cost_available_count = 0
          then null
          else round(recorded_actual_labor, 2)::text
        end,
      'recordedActualOtherDirect',
        case when other_cost_available_count = 0
          then null
          else round(recorded_actual_other, 2)::text
        end,
      'actualTotal',
        case when actual_total is null then null else actual_total::text end,
      'latestActualCostAsOf', latest_actual_cost_as_of
    ),
    'profitability', jsonb_build_object(
      'estimatedGrossProfit',
        case when estimated_gross_profit is null
          then null
          else estimated_gross_profit::text
        end,
      'estimatedGrossMarginPercent',
        case when estimated_gross_margin is null
          then null
          else estimated_gross_margin::text
        end,
      'actualGrossProfit',
        case when actual_gross_profit is null
          then null
          else actual_gross_profit::text
        end,
      'actualGrossMarginPercent',
        case when actual_gross_margin is null
          then null
          else actual_gross_margin::text
        end
    ),
    'receivables', jsonb_build_object(
      'recordedPaid', round(recorded_paid, 2)::text,
      'providerVerifiedPaid', round(provider_verified_paid, 2)::text,
      'openBalance', round(open_receivables, 2)::text,
      'pastDueBalance', round(past_due_receivables, 2)::text,
      'uncollectibleBalance', round(uncollectible_balance, 2)::text,
      'pendingPaymentAmount', round(pending_payment_amount, 2)::text,
      'pendingRefundAmount', round(pending_refund_amount, 2)::text,
      'openInvoiceCount', open_invoice_count,
      'pastDueInvoiceCount', past_due_invoice_count,
      'paidInvoiceCount', paid_invoice_count,
      'uncollectibleInvoiceCount', uncollectible_invoice_count
    ),
    'completeness', jsonb_build_object(
      'complete', cardinality(unknowns) = 0,
      'method', 'exact_server_numeric_aggregates',
      'invoiceLedgerComplete', invoice_ledger_complete,
      'paymentEvidenceComplete', payment_evidence_complete,
      'paymentEvidenceGapCount', payment_evidence_gap_count,
      'sourceIdListComplete', source_id_list_complete,
      'actualCosts', jsonb_build_object(
        'complete', actual_cost_complete,
        'snapshotCount', cost_snapshot_count,
        'materialAvailableCount', material_cost_available_count,
        'materialCompleteCount', material_cost_complete_count,
        'laborAvailableCount', labor_cost_available_count,
        'laborCompleteCount', labor_cost_complete_count,
        'otherDirectAvailableCount', other_cost_available_count,
        'otherDirectCompleteCount', other_cost_complete_count,
        'completeJobCount', actual_cost_complete_job_count,
        'requiredJobCount', profitability_job_count
      ),
      'unknowns', to_jsonb(unknowns)
    )
  );

  source_fingerprint := encode(
    extensions.digest(
      jsonb_build_object(
        'schemaVersion', result ->> 'schemaVersion',
        'companyId', p_company_id,
        'asOf', as_of_value,
        'jobs', result -> 'jobs',
        'revenue', result -> 'revenue',
        'costs', result -> 'costs',
        'profitability', result -> 'profitability',
        'receivables', result -> 'receivables',
        'sourceCounts', jsonb_build_object(
          'jobs', source_job_count,
          'invoices', source_invoice_count,
          'costSnapshots', source_cost_snapshot_count,
          'payments', source_payment_count,
          'providerEvents', source_provider_event_count
        ),
        'sourceIds', jsonb_build_object(
          'jobIds', to_jsonb(source_job_ids),
          'invoiceIds', to_jsonb(source_invoice_ids),
          'costSnapshotIds', to_jsonb(source_cost_snapshot_ids),
          'paymentIds', to_jsonb(source_payment_ids),
          'providerEventIds', to_jsonb(source_provider_event_ids)
        )
      )::text,
      'sha256'
    ),
    'hex'
  );

  return result || jsonb_build_object(
    'evidence', jsonb_build_object(
      'sourceIds', jsonb_build_object(
        'jobIds', to_jsonb(source_job_ids),
        'invoiceIds', to_jsonb(source_invoice_ids),
        'costSnapshotIds', to_jsonb(source_cost_snapshot_ids),
        'paymentIds', to_jsonb(source_payment_ids),
        'providerEventIds', to_jsonb(source_provider_event_ids)
      ),
      'sourceCounts', jsonb_build_object(
        'jobs', source_job_count,
        'invoices', source_invoice_count,
        'costSnapshots', source_cost_snapshot_count,
        'payments', source_payment_count,
        'providerEvents', source_provider_event_count
      ),
      'sourceFingerprint', source_fingerprint
    )
  );
end;
$$;

revoke all on function public.get_storyops_profitability_kpis(uuid)
  from public, anon;
grant execute on function public.get_storyops_profitability_kpis(uuid)
  to authenticated;

comment on function public.get_storyops_profitability_kpis(uuid) is
  'Owner/dispatcher-only, all-history completed/invoiced-job financial read model. Returns numeric values as decimal strings, explicit source IDs, completeness, and unknowns; never infers actual costs or payment evidence.';
