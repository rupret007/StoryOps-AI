-- Authenticated live estimating is calculated in the estimate-workflow Edge
-- function and committed here as one tenant-scoped, idempotent transaction.
-- Browser callers cannot invoke this function directly.

create table public.service_terms (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  version_label text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  terms_text text not null check (length(btrim(terms_text)) between 50 and 20000),
  review_reference text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  effective_from timestamptz not null,
  effective_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, version_label),
  check (effective_until is null or effective_until > effective_from),
  check (
    status <> 'approved'
    or (
      nullif(btrim(review_reference), '') is not null
      and reviewed_by is not null
      and reviewed_at is not null
    )
  )
);

create unique index service_terms_one_approved_idx
  on public.service_terms(company_id)
  where status = 'approved';

alter table public.service_terms enable row level security;
revoke all on table public.service_terms from public, anon;
grant select, insert, update on table public.service_terms to authenticated;

-- A measurement is usable for pricing only when a human has also classified
-- the exact service or add-on scope that it measures. Empty arrays fail closed
-- in the estimating RPC and let existing unclassified records be relabeled
-- without inventing applicability during this migration.
alter table public.property_measurements
  add column service_codes text[] not null default '{}',
  add column add_on_codes text[] not null default '{}',
  add constraint property_measurements_service_codes_nonblank
    check (array_position(service_codes, '') is null),
  add constraint property_measurements_add_on_codes_nonblank
    check (array_position(add_on_codes, '') is null);

-- Trusted workers receive finite, purpose-built snapshots below. They do not
-- receive direct access to tenant tables, including customer and lead PII.
revoke select on table
  public.service_terms,
  public.companies,
  public.company_memberships,
  public.leads,
  public.customers,
  public.properties,
  public.service_catalog,
  public.price_books,
  public.price_book_service_rules,
  public.price_book_attribute_multipliers,
  public.price_book_add_ons,
  public.price_book_travel_zones,
  public.property_measurements,
  public.photo_analyses
from service_role;

create policy service_terms_backoffice_select
  on public.service_terms
  for select
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  );
create policy service_terms_owner_insert
  on public.service_terms
  for insert
  with check (
    public.has_company_role(company_id, array['owner']::public.app_role[])
  );
create policy service_terms_owner_update
  on public.service_terms
  for update
  using (
    public.has_company_role(company_id, array['owner']::public.app_role[])
  )
  with check (
    public.has_company_role(company_id, array['owner']::public.app_role[])
  );

create or replace function public.protect_approved_service_terms()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' and old.status in ('approved', 'retired') then
    raise exception 'Approved service terms are immutable; create a new version';
  elsif old.status in ('approved', 'retired') and not (
    old.status = 'approved'
    and new.status = 'retired'
    and (
      to_jsonb(new) - array['status', 'updated_at', 'version']
      = to_jsonb(old) - array['status', 'updated_at', 'version']
    )
  ) then
    raise exception 'Approved service terms are immutable; create a new version';
  end if;
  return new;
end;
$$;

create trigger service_terms_immutable
  before update or delete on public.service_terms
  for each row execute function public.protect_approved_service_terms();
create trigger service_terms_timestamps
  before update on public.service_terms
  for each row execute function public.touch_record();
create trigger service_terms_audit
  after insert or update or delete on public.service_terms
  for each row execute function public.audit_mutation();

create or replace function public.resolve_estimate_actor(
  p_company_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  actor_snapshot jsonb;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'ESTIMATE_ACTOR_SCOPE_REQUIRED';
  end if;
  select jsonb_build_object(
    'role', membership.role::text,
    'timezone', company.timezone
  )
  into actor_snapshot
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
    and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active
    and membership.role in ('owner', 'dispatcher');
  if actor_snapshot is null then
    raise exception 'ESTIMATE_BACKOFFICE_ROLE_REQUIRED';
  end if;
  return actor_snapshot;
end;
$$;

revoke all on function public.resolve_estimate_actor(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_estimate_actor(uuid, uuid)
  to service_role;

create or replace function public.load_active_price_book_snapshot(
  p_company_id uuid,
  p_price_book_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  book public.price_books%rowtype;
begin
  select price_book.*
  into book
  from public.price_books price_book
  join public.companies company
    on company.id = price_book.company_id
    and company.status = 'active'
  where price_book.company_id = p_company_id
    and (p_price_book_id is null or price_book.id = p_price_book_id)
    and price_book.status = 'active'
    and price_book.published_at is not null
    and price_book.effective_from <= now()
    and (price_book.effective_until is null or price_book.effective_until > now())
  order by price_book.effective_from desc, price_book.id
  limit 1;
  if not found then
    raise exception 'ESTIMATE_PRICE_BOOK_NOT_EFFECTIVE';
  end if;
  if exists (
    select 1
    from public.price_book_service_rules rule
    left join public.service_catalog catalog
      on catalog.id = rule.service_catalog_id
      and catalog.company_id = rule.company_id
      and catalog.code = rule.service_code
    where rule.company_id = p_company_id
      and rule.price_book_id = book.id
      and (
        catalog.id is null
        or not catalog.active
        or nullif(btrim(catalog.safety_sop_reference), '') is null
      )
  ) then
    raise exception 'ESTIMATE_PRICE_BOOK_CATALOG_INVALID';
  end if;

  return jsonb_build_object(
    'book', jsonb_build_object(
      'id', book.id,
      'company_id', book.company_id,
      'created_at', book.created_at,
      'updated_at', book.updated_at,
      'version', book.version,
      'name', book.name,
      'version_label', book.version_label,
      'status', book.status,
      'effective_from', book.effective_from,
      'effective_until', book.effective_until,
      'currency', book.currency,
      'company_minimum', book.company_minimum::text,
      'default_tax_rate_pct', book.default_tax_rate_pct::text,
      'margin_floor_pct', book.margin_floor_pct::text,
      'automatic_discount_limit_pct', book.automatic_discount_limit_pct::text,
      'deposit_kind', book.deposit_kind,
      'deposit_value', book.deposit_value::text,
      'published_by', book.published_by,
      'published_at', book.published_at
    ),
    'rules', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', rule.id,
          'service_code', rule.service_code,
          'pricing_unit', rule.pricing_unit,
          'base_price', rule.base_price::text,
          'unit_price', rule.unit_price::text,
          'included_quantity', rule.included_quantity::text,
          'service_minimum', rule.service_minimum::text,
          'estimated_base_cost', rule.estimated_base_cost::text,
          'estimated_unit_cost', rule.estimated_unit_cost::text,
          'duration_base_minutes', rule.duration_base_minutes,
          'duration_minutes_per_unit', rule.duration_minutes_per_unit::text,
          'taxable', rule.taxable,
          'allowed_attribute_values', rule.allowed_attribute_values,
          'service_catalog', jsonb_build_object(
            'company_id', catalog.company_id,
            'active', catalog.active,
            'safety_sop_reference', catalog.safety_sop_reference
          )
        )
        order by rule.service_code
      )
      from public.price_book_service_rules rule
      join public.service_catalog catalog
        on catalog.id = rule.service_catalog_id
        and catalog.company_id = rule.company_id
        and catalog.code = rule.service_code
        and catalog.active
      where rule.company_id = p_company_id
        and rule.price_book_id = book.id
    ), '[]'::jsonb),
    'multipliers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'service_rule_id', multiplier.service_rule_id,
          'attribute', multiplier.attribute,
          'attribute_value', multiplier.attribute_value,
          'multiplier', multiplier.multiplier::text
        )
        order by multiplier.service_rule_id, multiplier.attribute, multiplier.attribute_value
      )
      from public.price_book_attribute_multipliers multiplier
      join public.price_book_service_rules rule
        on rule.id = multiplier.service_rule_id
        and rule.price_book_id = book.id
        and rule.company_id = p_company_id
      where multiplier.company_id = p_company_id
    ), '[]'::jsonb),
    'add_ons', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'service_rule_id', add_on.service_rule_id,
          'code', add_on.code,
          'name', add_on.name,
          'pricing_unit', add_on.pricing_unit,
          'unit_price', add_on.unit_price::text,
          'estimated_unit_cost', add_on.estimated_unit_cost::text,
          'duration_minutes_per_unit', add_on.duration_minutes_per_unit::text,
          'taxable', add_on.taxable
        )
        order by add_on.service_rule_id, add_on.code
      )
      from public.price_book_add_ons add_on
      join public.price_book_service_rules rule
        on rule.id = add_on.service_rule_id
        and rule.price_book_id = book.id
        and rule.company_id = p_company_id
      where add_on.company_id = p_company_id
    ), '[]'::jsonb),
    'zones', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'zone_code', zone.zone_code,
          'name', zone.name,
          'fee', zone.fee::text,
          'taxable', zone.taxable,
          'maximum_one_way_miles', zone.maximum_one_way_miles::text,
          'postal_codes', zone.postal_codes
        )
        order by zone.zone_code
      )
      from public.price_book_travel_zones zone
      where zone.company_id = p_company_id
        and zone.price_book_id = book.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.load_active_price_book_snapshot(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.load_active_price_book_snapshot(uuid, uuid)
  to service_role;

create or replace function public.load_estimate_context_snapshot(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_property_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  selected_property_id uuid;
  terms public.service_terms%rowtype;
begin
  perform public.resolve_estimate_actor(p_company_id, p_actor_user_id);
  if p_property_id is not null and not exists (
    select 1
    from public.properties property
    join public.customers customer
      on customer.id = property.customer_id
      and customer.company_id = property.company_id
      and customer.lifecycle <> 'blocked'
    where property.id = p_property_id
      and property.company_id = p_company_id
  ) then
    raise exception 'ESTIMATE_PROPERTY_NOT_FOUND';
  end if;
  selected_property_id := p_property_id;
  if selected_property_id is null then
    select property.id
    into selected_property_id
    from public.properties property
    join public.customers customer
      on customer.id = property.customer_id
      and customer.company_id = property.company_id
      and customer.lifecycle <> 'blocked'
    where property.company_id = p_company_id
    order by property.name, property.id
    limit 1;
  end if;
  select service_terms.*
  into terms
  from public.service_terms service_terms
  where service_terms.company_id = p_company_id
    and service_terms.status = 'approved'
    and service_terms.reviewed_by is not null
    and service_terms.reviewed_at is not null
    and nullif(btrim(service_terms.review_reference), '') is not null
    and service_terms.effective_from <= now()
    and (service_terms.effective_until is null or service_terms.effective_until > now())
  limit 1;
  if not found then
    raise exception 'ESTIMATE_APPROVED_TERMS_REQUIRED';
  end if;

  return jsonb_build_object(
    'customers', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', customer.id,
          'display_name', customer.display_name,
          'tax_exempt', customer.tax_exempt
        )
        order by customer.display_name, customer.id
      )
      from public.customers customer
      where customer.company_id = p_company_id
        and customer.lifecycle <> 'blocked'
    ), '[]'::jsonb),
    'properties', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', property.id,
          'customer_id', property.customer_id,
          'name', property.name,
          'service_address', property.service_address,
          'stories', property.stories
        )
        order by property.name, property.id
      )
      from public.properties property
      join public.customers customer
        on customer.id = property.customer_id
        and customer.company_id = property.company_id
        and customer.lifecycle <> 'blocked'
      where property.company_id = p_company_id
    ), '[]'::jsonb),
    'measurements', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', measurement.id,
          'property_id', measurement.property_id,
          'kind', measurement.kind,
          'label', measurement.label,
          'value', measurement.value::text,
          'unit', measurement.unit,
          'source', measurement.source,
          'measured_at', measurement.measured_at,
          'confidence', measurement.confidence::text,
          'verified_by_human', measurement.verified_by_human,
          'service_codes', measurement.service_codes,
          'add_on_codes', measurement.add_on_codes
        )
        order by measurement.measured_at desc, measurement.id
      )
      from public.property_measurements measurement
      where measurement.company_id = p_company_id
        and measurement.verified_by_human
        and (p_property_id is null or measurement.property_id = p_property_id)
        and exists (
          select 1
          from public.properties property
          join public.customers customer
            on customer.id = property.customer_id
            and customer.company_id = property.company_id
            and customer.lifecycle <> 'blocked'
          where property.id = measurement.property_id
            and property.company_id = measurement.company_id
        )
        and not exists (
          select 1
          from public.property_measurements replacement
          where replacement.company_id = measurement.company_id
            and replacement.property_id = measurement.property_id
            and replacement.supersedes_measurement_id = measurement.id
        )
    ), '[]'::jsonb),
    'photo_evidence', (
      select jsonb_build_object(
        'id', analysis.id,
        'overall_confidence', analysis.overall_confidence::text,
        'unknowns', analysis.unknowns,
        'disposition', analysis.disposition,
        'analyzed_at', analysis.analyzed_at,
        'injection_signals', analysis.injection_signals
      )
      from public.photo_analyses analysis
      where analysis.company_id = p_company_id
        and analysis.property_id = selected_property_id
        and analysis.purpose = 'scope'
      order by analysis.analyzed_at desc, analysis.id
      limit 1
    ),
    'service_terms', jsonb_build_object(
      'id', terms.id,
      'version_label', terms.version_label,
      'terms_text', terms.terms_text,
      'review_reference', terms.review_reference,
      'reviewed_at', terms.reviewed_at
    )
  );
end;
$$;

revoke all on function public.load_estimate_context_snapshot(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.load_estimate_context_snapshot(uuid, uuid, uuid)
  to service_role;

create or replace function public.load_estimate_calculation_snapshot(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_customer_id uuid,
  p_property_id uuid,
  p_lead_id uuid,
  p_measurement_ids uuid[],
  p_catalog_codes text[]
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  customer public.customers%rowtype;
  property public.properties%rowtype;
  lead public.leads%rowtype;
  terms public.service_terms%rowtype;
  requested_measurement_count integer;
  requested_catalog_count integer;
begin
  perform public.resolve_estimate_actor(p_company_id, p_actor_user_id);
  select customer_row.*
  into customer
  from public.customers customer_row
  where customer_row.id = p_customer_id
    and customer_row.company_id = p_company_id
    and customer_row.lifecycle <> 'blocked';
  if not found then
    raise exception 'ESTIMATE_CUSTOMER_NOT_FOUND';
  end if;
  select property_row.*
  into property
  from public.properties property_row
  where property_row.id = p_property_id
    and property_row.company_id = p_company_id
    and property_row.customer_id = p_customer_id;
  if not found then
    raise exception 'ESTIMATE_CUSTOMER_PROPERTY_MISMATCH';
  end if;
  if p_lead_id is not null then
    select lead_row.*
    into lead
    from public.leads lead_row
    where lead_row.id = p_lead_id
      and lead_row.company_id = p_company_id
      and (
        (
          lead_row.status in ('new', 'qualifying', 'qualified')
          and (lead_row.customer_id is null or lead_row.customer_id = p_customer_id)
          and (lead_row.property_id is null or lead_row.property_id = p_property_id)
        )
        or (
          lead_row.status = 'converted'
          and lead_row.customer_id = p_customer_id
          and lead_row.property_id = p_property_id
        )
      );
    if not found then
      raise exception 'ESTIMATE_LEAD_INVALID';
    end if;
  end if;
  select service_terms.*
  into terms
  from public.service_terms service_terms
  where service_terms.company_id = p_company_id
    and service_terms.status = 'approved'
    and service_terms.reviewed_by is not null
    and service_terms.reviewed_at is not null
    and nullif(btrim(service_terms.review_reference), '') is not null
    and service_terms.effective_from <= now()
    and (service_terms.effective_until is null or service_terms.effective_until > now())
  limit 1;
  if not found then
    raise exception 'ESTIMATE_APPROVED_TERMS_REQUIRED';
  end if;
  if coalesce(cardinality(p_measurement_ids), 0) = 0
    or cardinality(p_measurement_ids) <> (
      select count(distinct requested_id)
      from unnest(p_measurement_ids) requested_id
    )
  then
    raise exception 'ESTIMATE_MEASUREMENT_IDS_INVALID';
  end if;
  select count(*)
  into requested_measurement_count
  from public.property_measurements measurement
  where measurement.id = any(p_measurement_ids)
    and measurement.company_id = p_company_id
    and measurement.property_id = p_property_id
    and measurement.verified_by_human
    and not exists (
      select 1
      from public.property_measurements replacement
      where replacement.company_id = measurement.company_id
        and replacement.property_id = measurement.property_id
        and replacement.supersedes_measurement_id = measurement.id
    );
  if requested_measurement_count <> cardinality(p_measurement_ids) then
    raise exception 'ESTIMATE_MEASUREMENT_EVIDENCE_REQUIRED';
  end if;
  if coalesce(cardinality(p_catalog_codes), 0) = 0
    or cardinality(p_catalog_codes) <> (
      select count(distinct requested_code)
      from unnest(p_catalog_codes) requested_code
    )
    or exists (
      select 1
      from unnest(p_catalog_codes) requested_code
      where nullif(btrim(requested_code), '') is null
        or length(requested_code) > 100
    )
  then
    raise exception 'ESTIMATE_CATALOG_CODES_INVALID';
  end if;
  select count(*)
  into requested_catalog_count
  from public.service_catalog catalog
  where catalog.company_id = p_company_id
    and catalog.code = any(p_catalog_codes)
    and catalog.active
    and nullif(btrim(catalog.safety_sop_reference), '') is not null;
  if requested_catalog_count <> cardinality(p_catalog_codes) then
    raise exception 'ESTIMATE_SERVICE_CATALOG_INVALID';
  end if;

  return jsonb_build_object(
    'customer', jsonb_build_object(
      'id', customer.id,
      'tax_exempt', customer.tax_exempt,
      'version', customer.version,
      'updated_at', customer.updated_at
    ),
    'property', jsonb_build_object(
      'id', property.id,
      'customer_id', property.customer_id,
      'stories', property.stories,
      'service_address', property.service_address,
      'version', property.version,
      'updated_at', property.updated_at
    ),
    'lead', case
      when p_lead_id is null then null
      else jsonb_build_object(
        'id', lead.id,
        'customer_id', lead.customer_id,
        'property_id', lead.property_id,
        'status', lead.status
      )
    end,
    'service_catalog', (
      select jsonb_agg(
        jsonb_build_object(
          'id', catalog.id,
          'code', catalog.code,
          'version', catalog.version,
          'active', catalog.active,
          'safety_sop_reference', catalog.safety_sop_reference
        )
        order by catalog.code
      )
      from public.service_catalog catalog
      where catalog.company_id = p_company_id
        and catalog.code = any(p_catalog_codes)
        and catalog.active
        and nullif(btrim(catalog.safety_sop_reference), '') is not null
    ),
    'measurements', (
      select jsonb_agg(
        jsonb_build_object(
          'id', measurement.id,
          'property_id', measurement.property_id,
          'kind', measurement.kind,
          'label', measurement.label,
          'value', measurement.value::text,
          'unit', measurement.unit,
          'verified_by_human', measurement.verified_by_human,
          'updated_at', measurement.updated_at,
          'version', measurement.version,
          'service_codes', measurement.service_codes,
          'add_on_codes', measurement.add_on_codes
        )
        order by measurement.id
      )
      from public.property_measurements measurement
      where measurement.id = any(p_measurement_ids)
        and measurement.company_id = p_company_id
        and measurement.property_id = p_property_id
        and measurement.verified_by_human
    ),
    'photo_evidence', (
      select jsonb_build_object(
        'id', analysis.id,
        'disposition', analysis.disposition,
        'analyzed_at', analysis.analyzed_at
      )
      from public.photo_analyses analysis
      where analysis.company_id = p_company_id
        and analysis.property_id = p_property_id
        and analysis.purpose = 'scope'
      order by analysis.analyzed_at desc, analysis.id
      limit 1
    ),
    'service_terms', jsonb_build_object(
      'id', terms.id,
      'version_label', terms.version_label,
      'terms_text', terms.terms_text,
      'review_reference', terms.review_reference,
      'reviewed_at', terms.reviewed_at
    )
  );
end;
$$;

revoke all on function public.load_estimate_calculation_snapshot(
  uuid, uuid, uuid, uuid, uuid, uuid[], text[]
) from public, anon, authenticated;
grant execute on function public.load_estimate_calculation_snapshot(
  uuid, uuid, uuid, uuid, uuid, uuid[], text[]
) to service_role;

create or replace function public.load_stored_estimate_pricing_snapshot(
  p_company_id uuid,
  p_estimate_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  estimate_row public.estimates%rowtype;
  customer_row public.customers%rowtype;
begin
  select estimate.*
  into estimate_row
  from public.estimates estimate
  join public.companies company
    on company.id = estimate.company_id
    and company.status = 'active'
  where estimate.id = p_estimate_id
    and estimate.company_id = p_company_id;
  if not found then
    raise exception 'ESTIMATE_NOT_FOUND';
  end if;
  select customer.*
  into customer_row
  from public.customers customer
  where customer.id = estimate_row.customer_id
    and customer.company_id = p_company_id
    and customer.lifecycle <> 'blocked';
  if not found then
    raise exception 'ESTIMATE_CUSTOMER_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'estimate', jsonb_build_object(
      'id', estimate_row.id,
      'company_id', estimate_row.company_id,
      'customer_id', estimate_row.customer_id,
      'property_id', estimate_row.property_id,
      'price_book_id', estimate_row.price_book_id,
      'calculation_input', estimate_row.calculation_input,
      'calculated_at', estimate_row.calculated_at,
      'total', estimate_row.total::text
    ),
    'customer', jsonb_build_object(
      'tax_exempt', customer_row.tax_exempt
    ),
    'lines', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'line_kind', line.line_kind,
          'service_code', line.service_code,
          'add_on_code', line.add_on_code,
          'quantity', line.quantity::text,
          'source_measurement_ids', line.source_measurement_ids
        )
        order by line.sort_order, line.id
      )
      from public.estimate_lines line
      where line.company_id = p_company_id
        and line.estimate_id = p_estimate_id
    ), '[]'::jsonb),
    'measurements', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', measurement.id,
          'value', measurement.value::text,
          'property_id', measurement.property_id,
          'kind', measurement.kind,
          'unit', measurement.unit,
          'verified_by_human', measurement.verified_by_human,
          'service_codes', measurement.service_codes,
          'add_on_codes', measurement.add_on_codes,
          'superseded', exists (
            select 1
            from public.property_measurements replacement
            where replacement.company_id = measurement.company_id
              and replacement.property_id = measurement.property_id
              and replacement.supersedes_measurement_id = measurement.id
          )
        )
        order by measurement.id
      )
      from public.property_measurements measurement
      where measurement.company_id = p_company_id
        and measurement.property_id = estimate_row.property_id
        and measurement.id in (
          select unnest(line.source_measurement_ids)
          from public.estimate_lines line
          where line.company_id = p_company_id
            and line.estimate_id = p_estimate_id
        )
    ), '[]'::jsonb),
    'photo_evidence', (
      select jsonb_build_object(
        'disposition', analysis.disposition
      )
      from public.photo_analyses analysis
      where analysis.company_id = p_company_id
        and analysis.property_id = estimate_row.property_id
        and analysis.purpose = 'scope'
      order by analysis.analyzed_at desc, analysis.id
      limit 1
    )
  );
end;
$$;

revoke all on function public.load_stored_estimate_pricing_snapshot(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.load_stored_estimate_pricing_snapshot(uuid, uuid)
  to service_role;

create or replace function public.replay_priced_estimate(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_intent_hash text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  actor_role public.app_role;
  reservation public.idempotency_keys%rowtype;
begin
  select membership.role
  into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
    and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active;
  if actor_role is null or actor_role not in ('owner', 'dispatcher') then
    raise exception 'ESTIMATE_BACKOFFICE_ROLE_REQUIRED';
  end if;
  if p_idempotency_key is null
    or length(p_idempotency_key) not between 16 and 160
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_intent_hash is null
    or p_intent_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'ESTIMATE_IDEMPOTENCY_INPUT_INVALID';
  end if;
  select *
  into reservation
  from public.idempotency_keys
  where company_id = p_company_id
    and scope = 'priced-estimate-v1'
    and key = p_idempotency_key;
  if not found then
    return null;
  end if;
  if reservation.request_hash <> p_intent_hash then
    raise exception 'ESTIMATE_IDEMPOTENCY_CONFLICT';
  end if;
  if reservation.status = 'completed' then
    return reservation.response || jsonb_build_object('replayed', true);
  end if;
  raise exception 'ESTIMATE_ALREADY_IN_PROGRESS';
end;
$$;

revoke all on function public.replay_priced_estimate(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.replay_priced_estimate(uuid, uuid, text, text)
  to service_role;

create or replace function public.persist_priced_estimate(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_idempotency_key text,
  p_intent_hash text,
  p_snapshot_hash text,
  p_authoritative_snapshot jsonb,
  p_customer_id uuid,
  p_property_id uuid,
  p_lead_id uuid,
  p_price_book_id uuid,
  p_service_terms_id uuid,
  p_price_book_version text,
  p_calculation_input jsonb,
  p_result jsonb,
  p_terms_version text,
  p_terms_snapshot text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_role public.app_role;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  estimate_id_value uuid := gen_random_uuid();
  quote_id_value uuid := gen_random_uuid();
  approval_id_value uuid;
  estimate_number_value text;
  quote_number_value text;
  sequence_value bigint;
  quoteable_value boolean;
  estimate_status_value text;
  quote_status_value text;
  response_value jsonb;
  service_value jsonb;
  add_on_value jsonb;
  line_value jsonb;
  measurement_id_value uuid;
  catalog_code_value text;
  expected_measurement_id uuid;
  line_index integer := 0;
  approval_reason_value text;
  approval_summary_value text;
  approval_payload_value jsonb;
  company_timezone text;
  local_today date;
  snapshot_measurement_value jsonb;
  snapshot_catalog_value jsonb;
  snapshot_photo_id uuid;
  locked_customer public.customers%rowtype;
  locked_property public.properties%rowtype;
  locked_lead public.leads%rowtype;
  locked_price_book public.price_books%rowtype;
  locked_terms public.service_terms%rowtype;
  locked_catalog public.service_catalog%rowtype;
  referenced_measurement_ids uuid[];
  referenced_catalog_codes text[];
  affected_rows integer;
begin
  if p_company_id is null or p_actor_user_id is null then
    raise exception 'ESTIMATE_SCOPE_REQUIRED';
  end if;
  if p_idempotency_key is null
    or length(p_idempotency_key) not between 16 and 160
    or p_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  then
    raise exception 'ESTIMATE_IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_intent_hash is null or p_intent_hash !~ '^[a-f0-9]{64}$'
    or p_snapshot_hash is null or p_snapshot_hash !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_authoritative_snapshot) <> 'object'
  then
    raise exception 'ESTIMATE_REQUEST_HASH_INVALID';
  end if;
  if nullif(btrim(p_terms_version), '') is null
    or nullif(btrim(p_terms_snapshot), '') is null
  then
    raise exception 'ESTIMATE_TERMS_REQUIRED';
  end if;

  select membership.role
  , company.timezone
  into actor_role, company_timezone
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
    and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active
  for share of membership, company;
  if actor_role is null or actor_role not in ('owner', 'dispatcher') then
    raise exception 'ESTIMATE_BACKOFFICE_ROLE_REQUIRED';
  end if;
  local_today := (now() at time zone company_timezone)::date;

  if p_lead_id is not null then
    select lead.*
    into locked_lead
    from public.leads lead
    where lead.id = p_lead_id
      and lead.company_id = p_company_id
    for update;
    if not found or not (
      (
        locked_lead.status in ('new', 'qualifying', 'qualified')
        and (locked_lead.customer_id is null or locked_lead.customer_id = p_customer_id)
        and (locked_lead.property_id is null or locked_lead.property_id = p_property_id)
      )
      or (
        locked_lead.status = 'converted'
        and locked_lead.customer_id = p_customer_id
        and locked_lead.property_id = p_property_id
      )
    ) then
      raise exception 'ESTIMATE_LEAD_INVALID';
    end if;
  end if;

  select customer.*
  into locked_customer
  from public.customers customer
  where customer.id = p_customer_id
    and customer.company_id = p_company_id
  for update;
  if not found or locked_customer.lifecycle = 'blocked' then
    raise exception 'ESTIMATE_CUSTOMER_PROPERTY_MISMATCH';
  end if;

  -- FOR UPDATE on the exact property serializes child FK inserts, so a photo,
  -- measurement, or superseding measurement cannot appear between snapshot
  -- revalidation and commit.
  select property.*
  into locked_property
  from public.properties property
  where property.id = p_property_id
    and property.company_id = p_company_id
  for update;
  if not found or locked_property.customer_id <> p_customer_id then
    raise exception 'ESTIMATE_CUSTOMER_PROPERTY_MISMATCH';
  end if;

  select price_book.*
  into locked_price_book
  from public.price_books price_book
  where price_book.id = p_price_book_id
    and price_book.company_id = p_company_id
  for share;
  if not found
    or locked_price_book.version_label <> p_price_book_version
    or locked_price_book.status <> 'active'
    or locked_price_book.published_at is null
    or locked_price_book.effective_from > now()
    or (
      locked_price_book.effective_until is not null
      and locked_price_book.effective_until <= now()
    )
  then
    raise exception 'ESTIMATE_PRICE_BOOK_NOT_EFFECTIVE';
  end if;

  select terms.*
  into locked_terms
  from public.service_terms terms
  where terms.id = p_service_terms_id
    and terms.company_id = p_company_id
  for share;
  if not found
    or locked_terms.version_label <> p_terms_version
    or locked_terms.terms_text <> p_terms_snapshot
    or locked_terms.status <> 'approved'
    or locked_terms.reviewed_by is null
    or locked_terms.reviewed_at is null
    or nullif(btrim(locked_terms.review_reference), '') is null
    or locked_terms.effective_from > now()
    or (
      locked_terms.effective_until is not null
      and locked_terms.effective_until <= now()
    )
  then
    raise exception 'ESTIMATE_APPROVED_TERMS_REQUIRED';
  end if;
  if p_authoritative_snapshot #>> '{companyId}' <> p_company_id::text
    or p_authoritative_snapshot #>> '{customer,id}' <> p_customer_id::text
    or p_authoritative_snapshot #>> '{property,id}' <> p_property_id::text
    or p_authoritative_snapshot #>> '{priceBook,id}' <> p_price_book_id::text
    or p_authoritative_snapshot #>> '{priceBook,versionLabel}' <> p_price_book_version
    or p_authoritative_snapshot #>> '{serviceTerms,id}' <> p_service_terms_id::text
    or p_authoritative_snapshot #>> '{serviceTerms,versionLabel}' <> p_terms_version
  then
    raise exception 'ESTIMATE_AUTHORITATIVE_SNAPSHOT_SCOPE_MISMATCH';
  end if;
  if not exists (
    select 1
    from public.customers customer
    join public.properties property
      on property.id = p_property_id
      and property.company_id = customer.company_id
      and property.customer_id = customer.id
    where customer.id = p_customer_id
      and customer.company_id = p_company_id
      and customer.tax_exempt =
        coalesce((p_authoritative_snapshot #>> '{customer,taxExempt}')::boolean, false)
      and customer.version =
        (p_authoritative_snapshot #>> '{customer,version}')::integer
      and customer.updated_at =
        (p_authoritative_snapshot #>> '{customer,updatedAt}')::timestamptz
      and property.stories is not distinct from
        nullif(p_authoritative_snapshot #>> '{property,stories}', '')::smallint
      and property.version =
        (p_authoritative_snapshot #>> '{property,version}')::integer
      and property.updated_at =
        (p_authoritative_snapshot #>> '{property,updatedAt}')::timestamptz
      and left(
        coalesce(
          property.service_address ->> 'postalCode',
          property.service_address ->> 'postal_code'
        ),
        5
      ) = p_authoritative_snapshot #>> '{property,postalCode}'
  ) then
    raise exception 'ESTIMATE_AUTHORITATIVE_CUSTOMER_PROPERTY_CHANGED';
  end if;
  if p_authoritative_snapshot -> 'photoEvidence' = 'null'::jsonb then
    if exists (
      select 1
      from public.photo_analyses analysis
      where analysis.company_id = p_company_id
        and analysis.property_id = p_property_id
        and analysis.purpose = 'scope'
    ) then
      raise exception 'ESTIMATE_PHOTO_SNAPSHOT_CHANGED';
    end if;
  else
    snapshot_photo_id :=
      nullif(p_authoritative_snapshot #>> '{photoEvidence,id}', '')::uuid;
    if not exists (
      select 1
      from public.photo_analyses analysis
      where analysis.id = snapshot_photo_id
        and analysis.company_id = p_company_id
        and analysis.property_id = p_property_id
        and analysis.purpose = 'scope'
        and analysis.disposition =
          p_authoritative_snapshot #>> '{photoEvidence,disposition}'
        and analysis.analyzed_at =
          (p_authoritative_snapshot #>> '{photoEvidence,analyzedAt}')::timestamptz
        and analysis.id = (
          select latest.id
          from public.photo_analyses latest
          where latest.company_id = p_company_id
            and latest.property_id = p_property_id
            and latest.purpose = 'scope'
          order by latest.analyzed_at desc, latest.id
          limit 1
        )
    ) then
      raise exception 'ESTIMATE_PHOTO_SNAPSHOT_CHANGED';
    end if;
  end if;
  if p_authoritative_snapshot #>> '{travelZone,code}'
      <> p_calculation_input ->> 'travelZoneCode'
    or p_authoritative_snapshot #>> '{travelZone,postalCode}'
      <> p_authoritative_snapshot #>> '{property,postalCode}'
    or not exists (
      select 1
      from public.price_book_travel_zones zone
      where zone.company_id = p_company_id
        and zone.price_book_id = p_price_book_id
        and zone.zone_code = p_calculation_input ->> 'travelZoneCode'
        and (
          p_authoritative_snapshot #>> '{travelZone,postalCode}' = any(zone.postal_codes)
          or (
            cardinality(zone.postal_codes) = 0
            and not exists (
              select 1
              from public.price_book_travel_zones exact_zone
              where exact_zone.company_id = p_company_id
                and exact_zone.price_book_id = p_price_book_id
                and p_authoritative_snapshot #>> '{travelZone,postalCode}'
                  = any(exact_zone.postal_codes)
            )
            and zone.fee = (
              select max(default_zone.fee)
              from public.price_book_travel_zones default_zone
              where default_zone.company_id = p_company_id
                and default_zone.price_book_id = p_price_book_id
                and cardinality(default_zone.postal_codes) = 0
            )
          )
        )
    )
  then
    raise exception 'ESTIMATE_TRAVEL_ZONE_EVIDENCE_MISMATCH';
  end if;

  if jsonb_typeof(p_calculation_input) <> 'object'
    or jsonb_typeof(p_calculation_input -> 'services') <> 'array'
    or jsonb_array_length(p_calculation_input -> 'services') not between 1 and 12
    or jsonb_typeof(p_authoritative_snapshot -> 'measurements') <> 'array'
    or jsonb_typeof(p_authoritative_snapshot -> 'serviceCatalog') <> 'array'
  then
    raise exception 'ESTIMATE_CALCULATION_INPUT_INVALID';
  end if;
  select array_agg(reference_code order by reference_code)
  into referenced_catalog_codes
  from (
    select distinct service ->> 'serviceCode' as reference_code
    from jsonb_array_elements(p_calculation_input -> 'services') service
    union
    select distinct add_on ->> 'code'
    from jsonb_array_elements(p_calculation_input -> 'services') service,
      jsonb_array_elements(coalesce(service -> 'addOns', '[]'::jsonb)) add_on
  ) referenced
  where nullif(btrim(reference_code), '') is not null;
  if coalesce(cardinality(referenced_catalog_codes), 0) = 0
    or jsonb_array_length(p_authoritative_snapshot -> 'serviceCatalog')
      <> cardinality(referenced_catalog_codes)
    or exists (
      select 1
      from jsonb_array_elements(p_authoritative_snapshot -> 'serviceCatalog') snapshot_catalog
      where nullif(btrim(snapshot_catalog ->> 'code'), '') is null
        or not ((snapshot_catalog ->> 'code') = any(referenced_catalog_codes))
    )
    or exists (
      select 1
      from jsonb_array_elements(p_authoritative_snapshot -> 'serviceCatalog') snapshot_catalog
      group by snapshot_catalog ->> 'code'
      having count(*) > 1
    )
  then
    raise exception 'ESTIMATE_SERVICE_CATALOG_SNAPSHOT_SCOPE_MISMATCH';
  end if;
  foreach catalog_code_value in array referenced_catalog_codes
  loop
    select catalog.*
    into locked_catalog
    from public.service_catalog catalog
    where catalog.company_id = p_company_id
      and catalog.code = catalog_code_value
    for share;
    if not found then
      raise exception 'ESTIMATE_SERVICE_CATALOG_CHANGED';
    end if;
    select value
    into snapshot_catalog_value
    from jsonb_array_elements(p_authoritative_snapshot -> 'serviceCatalog')
    where value ->> 'code' = catalog_code_value
    limit 1;
    if not found
      or coalesce(snapshot_catalog_value ->> 'id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(snapshot_catalog_value ->> 'version', '') !~ '^[1-9][0-9]{0,9}$'
      or snapshot_catalog_value -> 'active' is distinct from 'true'::jsonb
      or nullif(btrim(snapshot_catalog_value ->> 'safetySopReference'), '') is null
      or locked_catalog.id <> (snapshot_catalog_value ->> 'id')::uuid
      or locked_catalog.version <> (snapshot_catalog_value ->> 'version')::integer
      or not locked_catalog.active
      or nullif(btrim(locked_catalog.safety_sop_reference), '') is null
      or locked_catalog.safety_sop_reference
        <> snapshot_catalog_value ->> 'safetySopReference'
    then
      raise exception 'ESTIMATE_SERVICE_CATALOG_CHANGED';
    end if;
  end loop;
  if exists (
    select 1
    from jsonb_array_elements(p_calculation_input -> 'services') service
    where (service ->> 'measurementId') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or exists (
        select 1
        from jsonb_array_elements(coalesce(service -> 'addOns', '[]'::jsonb)) add_on
        where (add_on ->> 'measurementId') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
  ) then
    raise exception 'ESTIMATE_MEASUREMENT_IDS_INVALID';
  end if;
  select array_agg(reference_id order by reference_id)
  into referenced_measurement_ids
  from (
    select distinct (service ->> 'measurementId')::uuid as reference_id
    from jsonb_array_elements(p_calculation_input -> 'services') service
    union
    select distinct (add_on ->> 'measurementId')::uuid
    from jsonb_array_elements(p_calculation_input -> 'services') service,
      jsonb_array_elements(coalesce(service -> 'addOns', '[]'::jsonb)) add_on
  ) referenced;
  if coalesce(cardinality(referenced_measurement_ids), 0) = 0
    or jsonb_array_length(p_authoritative_snapshot -> 'measurements')
      <> cardinality(referenced_measurement_ids)
    or exists (
      select 1
      from jsonb_array_elements(p_authoritative_snapshot -> 'measurements') snapshot_measurement
      where (snapshot_measurement ->> 'id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or not ((snapshot_measurement ->> 'id')::uuid = any(referenced_measurement_ids))
    )
    or exists (
      select 1
      from jsonb_array_elements(p_authoritative_snapshot -> 'measurements') snapshot_measurement
      group by snapshot_measurement ->> 'id'
      having count(*) > 1
    )
  then
    raise exception 'ESTIMATE_MEASUREMENT_SNAPSHOT_SCOPE_MISMATCH';
  end if;
  foreach measurement_id_value in array referenced_measurement_ids
  loop
    perform 1
    from public.property_measurements measurement
    where measurement.id = measurement_id_value
      and measurement.company_id = p_company_id
      and measurement.property_id = p_property_id
    for update;
    if not found then
      raise exception 'ESTIMATE_MEASUREMENT_EVIDENCE_REQUIRED';
    end if;
  end loop;
  if exists (
    select 1
    from jsonb_array_elements(p_calculation_input -> 'services') service
    group by service ->> 'serviceCode'
    having count(*) > 1
  ) then
    raise exception 'ESTIMATE_DUPLICATE_SERVICE';
  end if;
  if jsonb_typeof(p_result) <> 'object'
    or jsonb_typeof(p_result -> 'lines') <> 'array'
    or jsonb_typeof(p_result -> 'issues') <> 'array'
    or jsonb_typeof(p_result -> 'approvalFlags') <> 'array'
  then
    raise exception 'ESTIMATE_RESULT_INVALID';
  end if;
  if p_result ->> 'requestId' <> ('estimate:' || p_snapshot_hash)
    or p_result ->> 'priceBookId' <> p_price_book_id::text
    or p_result ->> 'priceBookVersion' <> p_price_book_version
    or nullif(p_result ->> 'calculationVersion', '') is null
  then
    raise exception 'ESTIMATE_RESULT_SCOPE_MISMATCH';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_result -> 'issues') issue
    where issue ->> 'severity' = 'error'
  ) then
    raise exception 'ESTIMATE_RESULT_HAS_ERRORS';
  end if;
  if (p_result #>> '{serviceSubtotal,amount}') !~ '^(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    or (p_result #>> '{minimumAdjustment,amount}') !~ '^(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    or (p_result #>> '{travelFee,amount}') !~ '^(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    or (p_result #>> '{manualAdjustment,amount}') <> '0.00'
    or (p_result #>> '{discount,amount}') !~ '^(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    or (p_result #>> '{taxableSubtotal,amount}') !~ '^(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    or (p_result #>> '{tax,amount}') !~ '^(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    or (p_result #>> '{total,amount}') !~ '^(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    or (p_result #>> '{depositRequired,amount}') !~ '^(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    or (p_result #>> '{estimatedCost,amount}') !~ '^(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    or (p_result ->> 'marginPercent') !~ '^-?(?:0|[1-9][0-9]{0,3})(?:[.][0-9]+)?$'
    or (p_result ->> 'durationMinutes') !~ '^[0-9]{1,7}$'
    or (p_result ->> 'calculatedAt') is null
    or (p_result ->> 'calculatedAt')::timestamptz < now() - interval '5 minutes'
    or (p_result ->> 'calculatedAt')::timestamptz > now() + interval '1 minute'
  then
    raise exception 'ESTIMATE_RESULT_NUMBERS_INVALID';
  end if;

  for service_value in
    select value from jsonb_array_elements(p_calculation_input -> 'services')
  loop
    if jsonb_typeof(service_value) <> 'object'
      or nullif(service_value ->> 'serviceCode', '') is null
      or (service_value ->> 'measurementId') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (service_value ->> 'quantity') !~ '^(?:0|[1-9][0-9]{0,9})(?:[.][0-9]{1,4})?$'
      or service_value ->> 'pricingUnit' not in ('sq_ft', 'linear_ft', 'each')
      or coalesce(jsonb_typeof(service_value -> 'sourceMeasurementIds'), '') <> 'array'
      or service_value #>> '{classificationEvidence,source}' <> 'operator_assertion'
      or service_value #>> '{classificationEvidence,assertedBy}' <> p_actor_user_id::text
      or (service_value #>> '{classificationEvidence,assertedAt}')::timestamptz
        <> (p_result ->> 'calculatedAt')::timestamptz
    then
      raise exception 'ESTIMATE_SERVICE_INPUT_INVALID';
    end if;
    measurement_id_value := (service_value ->> 'measurementId')::uuid;
    select value
    into snapshot_measurement_value
    from jsonb_array_elements(p_authoritative_snapshot -> 'measurements')
    where value ->> 'id' = measurement_id_value::text
    limit 1;
    if not (service_value -> 'sourceMeasurementIds') @> jsonb_build_array(measurement_id_value::text)
      or snapshot_measurement_value is null
      or not exists (
        select 1
        from public.property_measurements measurement
        where measurement.id = measurement_id_value
          and measurement.company_id = p_company_id
          and measurement.property_id = p_property_id
          and measurement.verified_by_human
          and measurement.value = (service_value ->> 'quantity')::numeric
          and measurement.value =
            (snapshot_measurement_value ->> 'value')::numeric
          and measurement.kind = snapshot_measurement_value ->> 'kind'
          and measurement.unit = snapshot_measurement_value ->> 'unit'
          and service_value ->> 'serviceCode' = any(measurement.service_codes)
          and (
            select coalesce(jsonb_agg(code order by code), '[]'::jsonb)
            from unnest(measurement.service_codes) code
          ) = snapshot_measurement_value -> 'serviceCodes'
          and (
            select coalesce(jsonb_agg(code order by code), '[]'::jsonb)
            from unnest(measurement.add_on_codes) code
          ) = snapshot_measurement_value -> 'addOnCodes'
          and measurement.version =
            (snapshot_measurement_value ->> 'version')::integer
          and measurement.updated_at =
            (snapshot_measurement_value ->> 'updatedAt')::timestamptz
          and (
            (service_value ->> 'pricingUnit' = 'sq_ft'
              and measurement.kind = 'area_sq_ft'
              and measurement.unit = 'sq_ft')
            or (service_value ->> 'pricingUnit' = 'linear_ft'
              and measurement.kind = 'length_linear_ft'
              and measurement.unit = 'linear_ft')
            or (service_value ->> 'pricingUnit' = 'each'
              and measurement.kind = 'count'
              and measurement.unit = 'each')
          )
          and exists (
            select 1
            from public.price_book_service_rules rule
            where rule.company_id = p_company_id
              and rule.price_book_id = p_price_book_id
              and rule.service_code = service_value ->> 'serviceCode'
              and rule.pricing_unit = service_value ->> 'pricingUnit'
          )
          and not exists (
            select 1
            from public.property_measurements replacement
            where replacement.company_id = measurement.company_id
              and replacement.property_id = measurement.property_id
              and replacement.supersedes_measurement_id = measurement.id
          )
      )
    then
      raise exception 'ESTIMATE_SERVICE_EVIDENCE_MISMATCH';
    end if;
    if jsonb_typeof(coalesce(service_value -> 'addOns', '[]'::jsonb)) <> 'array' then
      raise exception 'ESTIMATE_ADD_ON_INPUT_INVALID';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(coalesce(service_value -> 'addOns', '[]'::jsonb)) add_on
      group by add_on ->> 'code'
      having count(*) > 1
    ) then
      raise exception 'ESTIMATE_DUPLICATE_ADD_ON';
    end if;
    for add_on_value in
      select value from jsonb_array_elements(coalesce(service_value -> 'addOns', '[]'::jsonb))
    loop
      if nullif(add_on_value ->> 'code', '') is null
        or (add_on_value ->> 'measurementId') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or (add_on_value ->> 'quantity') !~ '^(?:0|[1-9][0-9]{0,9})(?:[.][0-9]{1,4})?$'
        or add_on_value ->> 'pricingUnit' not in ('sq_ft', 'linear_ft', 'each')
      then
        raise exception 'ESTIMATE_ADD_ON_INPUT_INVALID';
      end if;
      measurement_id_value := (add_on_value ->> 'measurementId')::uuid;
      select value
      into snapshot_measurement_value
      from jsonb_array_elements(p_authoritative_snapshot -> 'measurements')
      where value ->> 'id' = measurement_id_value::text
      limit 1;
      if not (service_value -> 'sourceMeasurementIds') @>
          jsonb_build_array(measurement_id_value::text)
        or snapshot_measurement_value is null
        or not exists (
          select 1
          from public.property_measurements measurement
          where measurement.id = measurement_id_value
            and measurement.company_id = p_company_id
            and measurement.property_id = p_property_id
            and measurement.verified_by_human
            and measurement.value = (add_on_value ->> 'quantity')::numeric
            and measurement.value =
              (snapshot_measurement_value ->> 'value')::numeric
            and measurement.kind = snapshot_measurement_value ->> 'kind'
            and measurement.unit = snapshot_measurement_value ->> 'unit'
            and add_on_value ->> 'code' = any(measurement.add_on_codes)
            and (
              select coalesce(jsonb_agg(code order by code), '[]'::jsonb)
              from unnest(measurement.service_codes) code
            ) = snapshot_measurement_value -> 'serviceCodes'
            and (
              select coalesce(jsonb_agg(code order by code), '[]'::jsonb)
              from unnest(measurement.add_on_codes) code
            ) = snapshot_measurement_value -> 'addOnCodes'
            and measurement.version =
              (snapshot_measurement_value ->> 'version')::integer
            and measurement.updated_at =
              (snapshot_measurement_value ->> 'updatedAt')::timestamptz
            and (
              (add_on_value ->> 'pricingUnit' = 'sq_ft'
                and measurement.kind = 'area_sq_ft'
                and measurement.unit = 'sq_ft')
              or (add_on_value ->> 'pricingUnit' = 'linear_ft'
                and measurement.kind = 'length_linear_ft'
                and measurement.unit = 'linear_ft')
              or (add_on_value ->> 'pricingUnit' = 'each'
                and measurement.kind = 'count'
                and measurement.unit = 'each')
            )
            and exists (
              select 1
              from public.price_book_service_rules rule
              join public.price_book_add_ons configured_add_on
                on configured_add_on.service_rule_id = rule.id
                and configured_add_on.company_id = rule.company_id
              where rule.company_id = p_company_id
                and rule.price_book_id = p_price_book_id
                and rule.service_code = service_value ->> 'serviceCode'
                and configured_add_on.code = add_on_value ->> 'code'
                and configured_add_on.pricing_unit = add_on_value ->> 'pricingUnit'
            )
            and not exists (
              select 1
              from public.property_measurements replacement
              where replacement.company_id = measurement.company_id
                and replacement.property_id = measurement.property_id
                and replacement.supersedes_measurement_id = measurement.id
            )
        )
      then
        raise exception 'ESTIMATE_ADD_ON_EVIDENCE_MISMATCH';
      end if;
    end loop;
  end loop;

  for line_value in select value from jsonb_array_elements(p_result -> 'lines')
  loop
    if line_value ->> 'kind' not in (
      'service', 'add_on', 'company_minimum', 'travel', 'manual_adjustment'
    )
      or (line_value ->> 'unitPrice') !~
        '^-?(?:0|[1-9][0-9]{0,5})(?:[.][0-9]{1,6})?$'
      or (line_value #>> '{subtotal,amount}') !~
        '^-?(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
      or (line_value #>> '{estimatedCost,amount}') !~
        '^(?:0|[1-9][0-9]{0,9})[.][0-9]{2}$'
      or (line_value ->> 'quantity') !~ '^(?:0|[1-9][0-9]{0,9})(?:[.][0-9]+)?$'
      or (line_value ->> 'multiplier') !~ '^(?:0|[1-9][0-9]{0,9})(?:[.][0-9]+)?$'
    then
      raise exception 'ESTIMATE_LINE_INVALID';
    end if;
    if line_value ->> 'kind' = 'service' then
      select (service ->> 'measurementId')::uuid
      into expected_measurement_id
      from jsonb_array_elements(p_calculation_input -> 'services') service
      where service ->> 'serviceCode' = line_value ->> 'serviceCode'
        and (service ->> 'quantity')::numeric = (line_value ->> 'quantity')::numeric
      limit 1;
      if expected_measurement_id is null
        or line_value -> 'sourceMeasurementIds'
          <> jsonb_build_array(expected_measurement_id::text)
      then
        raise exception 'ESTIMATE_SERVICE_LINE_EVIDENCE_MISMATCH';
      end if;
    elsif line_value ->> 'kind' = 'add_on' then
      select (add_on ->> 'measurementId')::uuid
      into expected_measurement_id
      from jsonb_array_elements(p_calculation_input -> 'services') service,
        jsonb_array_elements(coalesce(service -> 'addOns', '[]'::jsonb)) add_on
      where service ->> 'serviceCode' = line_value ->> 'serviceCode'
        and add_on ->> 'code' = line_value ->> 'addOnCode'
        and (add_on ->> 'quantity')::numeric = (line_value ->> 'quantity')::numeric
      limit 1;
      if expected_measurement_id is null
        or line_value -> 'sourceMeasurementIds'
          <> jsonb_build_array(expected_measurement_id::text)
      then
        raise exception 'ESTIMATE_ADD_ON_LINE_EVIDENCE_MISMATCH';
      end if;
    elsif coalesce(line_value -> 'sourceMeasurementIds', '[]'::jsonb) <> '[]'::jsonb then
      raise exception 'ESTIMATE_ADJUSTMENT_LINE_EVIDENCE_INVALID';
    end if;
  end loop;

  quoteable_value := coalesce((p_result ->> 'quoteable')::boolean, false);
  if quoteable_value and exists (
    select 1
    from jsonb_array_elements(p_result -> 'approvalFlags') flag
    where coalesce((flag ->> 'blocking')::boolean, false)
  ) then
    raise exception 'ESTIMATE_QUOTEABLE_FLAG_MISMATCH';
  elsif not quoteable_value and not exists (
    select 1
    from jsonb_array_elements(p_result -> 'approvalFlags') flag
    where coalesce((flag ->> 'blocking')::boolean, false)
  ) then
    raise exception 'ESTIMATE_APPROVAL_FLAG_REQUIRED';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'priced-estimate-v1',
    p_idempotency_key,
    p_intent_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'priced-estimate-v1'
      and key = p_idempotency_key
    for update;
    if reservation.request_hash <> p_intent_hash then
      raise exception 'ESTIMATE_IDEMPOTENCY_CONFLICT';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'ESTIMATE_ALREADY_IN_PROGRESS';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('storyops-priced-estimate:' || p_company_id::text, 0)
  );
  select greatest(
    coalesce((
      select max((regexp_match(estimate.estimate_number, '([0-9]+)$'))[1]::bigint)
      from public.estimates estimate
      where estimate.company_id = p_company_id
    ), 0),
    coalesce((
      select max((regexp_match(quote.quote_number, '([0-9]+)$'))[1]::bigint)
      from public.quotes quote
      where quote.company_id = p_company_id
    ), 0)
  ) + 1
  into sequence_value
  ;
  estimate_number_value := format(
    'EST-%s-%s',
    extract(year from local_today)::integer,
    lpad(sequence_value::text, 4, '0')
  );
  quote_number_value := format(
    'Q-%s-%s',
    extract(year from local_today)::integer,
    lpad(sequence_value::text, 4, '0')
  );
  estimate_status_value := case when quoteable_value then 'approved' else 'pending_approval' end;
  quote_status_value := case when quoteable_value then 'draft' else 'pending_approval' end;

  insert into public.estimates(
    id, company_id, estimate_number, customer_id, property_id, lead_id,
    price_book_id, price_book_version, status, service_subtotal,
    minimum_adjustment, travel_fee, manual_adjustment, discount,
    taxable_subtotal, tax, total, deposit_required, estimated_cost,
    estimated_margin_pct, duration_minutes, calculation_version,
    calculation_input, calculation_issues, evidence_analysis_ids, calculated_at
  )
  values (
    estimate_id_value,
    p_company_id,
    estimate_number_value,
    p_customer_id,
    p_property_id,
    p_lead_id,
    p_price_book_id,
    p_price_book_version,
    estimate_status_value,
    (p_result #>> '{serviceSubtotal,amount}')::numeric,
    (p_result #>> '{minimumAdjustment,amount}')::numeric,
    (p_result #>> '{travelFee,amount}')::numeric,
    0,
    (p_result #>> '{discount,amount}')::numeric,
    (p_result #>> '{taxableSubtotal,amount}')::numeric,
    (p_result #>> '{tax,amount}')::numeric,
    (p_result #>> '{total,amount}')::numeric,
    (p_result #>> '{depositRequired,amount}')::numeric,
    (p_result #>> '{estimatedCost,amount}')::numeric,
    (p_result ->> 'marginPercent')::numeric,
    (p_result ->> 'durationMinutes')::integer,
    p_result ->> 'calculationVersion',
    p_calculation_input,
    p_result -> 'issues',
    case
      when snapshot_photo_id is null then '{}'::uuid[]
      else array[snapshot_photo_id]::uuid[]
    end,
    (p_result ->> 'calculatedAt')::timestamptz
  );

  for line_value in select value from jsonb_array_elements(p_result -> 'lines')
  loop
    line_index := line_index + 10;
    insert into public.estimate_lines(
      company_id, estimate_id, line_kind, service_code, add_on_code,
      description, quantity, unit, unit_price, multiplier, subtotal,
      taxable, estimated_cost, source_measurement_ids, sort_order
    )
    values (
      p_company_id,
      estimate_id_value,
      line_value ->> 'kind',
      nullif(line_value ->> 'serviceCode', ''),
      nullif(line_value ->> 'addOnCode', ''),
      line_value ->> 'description',
      (line_value ->> 'quantity')::numeric,
      line_value ->> 'unit',
      (line_value ->> 'unitPrice')::numeric,
      (line_value ->> 'multiplier')::numeric,
      (line_value #>> '{subtotal,amount}')::numeric,
      coalesce((line_value ->> 'taxable')::boolean, false),
      (line_value #>> '{estimatedCost,amount}')::numeric,
      coalesce(
        array(
          select value::uuid
          from jsonb_array_elements_text(
            coalesce(line_value -> 'sourceMeasurementIds', '[]'::jsonb)
          )
        ),
        '{}'::uuid[]
      ),
      line_index
    );
  end loop;

  insert into public.quotes(
    id, company_id, quote_number, estimate_id, customer_id, property_id,
    status, valid_until, terms_version, terms_snapshot, total, deposit_required
  )
  values (
    quote_id_value,
    p_company_id,
    quote_number_value,
    estimate_id_value,
    p_customer_id,
    p_property_id,
    quote_status_value,
    local_today + 14,
    p_terms_version,
    p_terms_snapshot,
    (p_result #>> '{total,amount}')::numeric,
    (p_result #>> '{depositRequired,amount}')::numeric
  );

  if not quoteable_value then
    approval_id_value := gen_random_uuid();
    select
      flag ->> 'reason',
      flag ->> 'summary'
    into approval_reason_value, approval_summary_value
    from jsonb_array_elements(p_result -> 'approvalFlags') flag
    where coalesce((flag ->> 'blocking')::boolean, false)
    order by flag ->> 'reason'
    limit 1;
    approval_payload_value := jsonb_build_object(
      'estimateId', estimate_id_value,
      'quoteId', quote_id_value,
      'intentHash', p_intent_hash,
      'authoritativeSnapshotHash', p_snapshot_hash,
      'snapshot', jsonb_build_object(
        'priceBookId', p_price_book_id,
        'priceBookVersion', p_price_book_version,
        'serviceTermsId', p_service_terms_id,
        'termsVersion', p_terms_version,
        'calculationVersion', p_result ->> 'calculationVersion',
        'total', p_result #>> '{total,amount}',
        'depositRequired', p_result #>> '{depositRequired,amount}',
        'discount', p_result #>> '{discount,amount}',
        'marginPercent', (p_result ->> 'marginPercent')::numeric(9,4)::text
      ),
      'approvalFlags', p_result -> 'approvalFlags'
    );
    insert into public.approval_requests(
      id, company_id, reason, risk_level, status, requested_by_type,
      requested_by_id, requested_at, expires_at, entity_type, entity_id,
      action_type, action_payload, summary, policy_version
    )
    values (
      approval_id_value,
      p_company_id,
      approval_reason_value,
      'medium',
      'pending',
      'user',
      p_actor_user_id::text,
      now(),
      now() + interval '24 hours',
      'estimate',
      estimate_id_value,
      'estimate.approve_exception',
      approval_payload_value,
      approval_summary_value,
      'storyops-policy-v1.0.0'
    );
  end if;

  if p_lead_id is not null then
    update public.leads
    set
      status = 'converted',
      customer_id = p_customer_id,
      property_id = p_property_id
    where id = p_lead_id
      and company_id = p_company_id
      and (
        (
          status in ('new', 'qualifying', 'qualified')
          and (customer_id is null or customer_id = p_customer_id)
          and (property_id is null or property_id = p_property_id)
        )
        or (
          status = 'converted'
          and customer_id = p_customer_id
          and property_id = p_property_id
        )
      );
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then
      raise exception 'ESTIMATE_LEAD_COMMIT_CONFLICT';
    end if;
  end if;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id, retain_until
  )
  values (
    p_company_id,
    'user',
    p_actor_user_id::text,
    'estimate.priced',
    'estimates',
    estimate_id_value,
    jsonb_build_object(
      'estimateNumber', estimate_number_value,
      'priceBookVersion', p_price_book_version,
      'status', estimate_status_value,
      'total', p_result #>> '{total,amount}',
      'requestHash', p_intent_hash,
      'authoritativeSnapshotHash', p_snapshot_hash
    ),
    p_idempotency_key,
    now() + interval '7 years'
  );

  response_value := jsonb_build_object(
    'estimateId', estimate_id_value,
    'estimateNumber', estimate_number_value,
    'quoteId', quote_id_value,
    'quoteNumber', quote_number_value,
    'approvalId', approval_id_value,
    'estimateStatus', estimate_status_value,
    'quoteStatus', quote_status_value,
    'total', p_result #>> '{total,amount}',
    'depositRequired', p_result #>> '{depositRequired,amount}',
    'calculationVersion', p_result ->> 'calculationVersion',
    'requestHash', p_intent_hash,
    'authoritativeSnapshotHash', p_snapshot_hash,
    'replayed', false
  );
  update public.idempotency_keys
  set
    status = 'completed',
    response = response_value,
    completed_at = now()
  where id = reservation_id
    and status = 'in_progress';
  if not found then
    raise exception 'ESTIMATE_IDEMPOTENCY_RESERVATION_LOST';
  end if;
  return response_value;
end;
$$;

revoke all on function public.persist_priced_estimate(
  uuid, uuid, text, text, text, jsonb, uuid, uuid, uuid, uuid, uuid,
  text, jsonb, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.persist_priced_estimate(
  uuid, uuid, text, text, text, jsonb, uuid, uuid, uuid, uuid, uuid,
  text, jsonb, jsonb, text, text
) to service_role;

create or replace function public.apply_estimate_exception_decision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  estimate_id_value uuid;
  quote_id_value uuid;
  expected_snapshot jsonb;
begin
  if old.status <> 'pending'
    or new.status not in ('approved', 'rejected', 'expired', 'cancelled')
    or new.action_type <> 'estimate.approve_exception'
  then
    return new;
  end if;
  estimate_id_value := nullif(new.action_payload ->> 'estimateId', '')::uuid;
  quote_id_value := nullif(new.action_payload ->> 'quoteId', '')::uuid;
  if estimate_id_value is null
    or quote_id_value is null
    or new.entity_type <> 'estimate'
    or new.entity_id is distinct from estimate_id_value
  then
    raise exception 'ESTIMATE_APPROVAL_SCOPE_MISMATCH';
  end if;

  if new.status = 'approved' then
    select jsonb_build_object(
      'priceBookId', estimate.price_book_id,
      'priceBookVersion', estimate.price_book_version,
      'serviceTermsId', terms.id,
      'termsVersion', quote.terms_version,
      'calculationVersion', estimate.calculation_version,
      'total', estimate.total::text,
      'depositRequired', estimate.deposit_required::text,
      'discount', estimate.discount::text,
      'marginPercent', estimate.estimated_margin_pct::text
    )
    into expected_snapshot
    from public.estimates estimate
    join public.quotes quote
      on quote.id = quote_id_value
      and quote.estimate_id = estimate.id
      and quote.company_id = estimate.company_id
    join public.service_terms terms
      on terms.company_id = quote.company_id
      and terms.version_label = quote.terms_version
      and terms.terms_text = quote.terms_snapshot
    where estimate.id = estimate_id_value
      and estimate.company_id = new.company_id
      and estimate.status = 'pending_approval'
      and quote.status = 'pending_approval'
    for update of estimate, quote;
    if expected_snapshot is null
      or expected_snapshot <> new.action_payload -> 'snapshot'
    then
      raise exception 'ESTIMATE_APPROVAL_EXACT_PAYLOAD_MISMATCH';
    end if;
    update public.estimates
    set status = 'approved'
    where id = estimate_id_value
      and company_id = new.company_id
      and status = 'pending_approval';
    update public.quotes
    set status = 'draft'
    where id = quote_id_value
      and company_id = new.company_id
      and status = 'pending_approval';
    update public.approval_requests
    set
      consumed_at = now(),
      execution_receipt = jsonb_build_object(
        'kind', 'estimate-exception-decision',
        'estimateId', estimate_id_value,
        'quoteId', quote_id_value,
        'decidedBy', new.decided_by,
        'decidedAt', new.decided_at,
        'intentHash', new.action_payload ->> 'intentHash',
        'authoritativeSnapshotHash',
          new.action_payload ->> 'authoritativeSnapshotHash'
      )
    where id = new.id
      and company_id = new.company_id
      and status = 'approved'
      and consumed_at is null;
  else
    update public.estimates
    set status = 'needs_input'
    where id = estimate_id_value
      and company_id = new.company_id
      and status = 'pending_approval';
    update public.quotes
    set status = 'void'
    where id = quote_id_value
      and company_id = new.company_id
      and status = 'pending_approval';
  end if;
  return new;
end;
$$;

revoke all on function public.apply_estimate_exception_decision()
  from public, anon, authenticated;

create trigger approval_requests_apply_estimate_exception
  after update of status on public.approval_requests
  for each row execute function public.apply_estimate_exception_decision();

create or replace function public.expire_pending_estimate_approvals(
  p_company_id uuid
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected integer;
begin
  if auth.role() <> 'service_role' and current_user <> 'postgres' then
    raise exception 'Estimate approval expiry is service-role controlled';
  end if;
  update public.approval_requests
  set
    status = 'expired',
    decided_at = now(),
    decision_note = 'Expired automatically before another estimate workflow operation.'
  where company_id = p_company_id
    and action_type = 'estimate.approve_exception'
    and status = 'pending'
    and expires_at <= now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.expire_pending_estimate_approvals(uuid)
  from public, anon, authenticated;
grant execute on function public.expire_pending_estimate_approvals(uuid)
  to service_role;

create or replace function public.enforce_approved_terms_on_quote_send()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.status = 'sent' and old.status <> 'sent' and not exists (
    select 1
    from public.service_terms terms
    where terms.company_id = new.company_id
      and terms.version_label = new.terms_version
      and terms.terms_text = new.terms_snapshot
      and terms.status = 'approved'
      and terms.reviewed_by is not null
      and terms.reviewed_at is not null
      and nullif(btrim(terms.review_reference), '') is not null
      and terms.effective_from <= now()
      and (terms.effective_until is null or terms.effective_until > now())
  ) then
    raise exception 'QUOTE_APPROVED_TERMS_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger quotes_approved_terms_gate
  before update of status on public.quotes
  for each row execute function public.enforce_approved_terms_on_quote_send();

revoke all on function public.enforce_approved_terms_on_quote_send()
  from public, anon, authenticated;

comment on function public.persist_priced_estimate(
  uuid, uuid, text, text, text, jsonb, uuid, uuid, uuid, uuid, uuid,
  text, jsonb, jsonb, text, text
) is
  'Trusted Edge-only atomic persistence for deterministic, evidence-backed estimate and quote snapshots with durable idempotency.';
comment on function public.apply_estimate_exception_decision() is
  'Applies an owner estimate-exception decision only when the immutable approval snapshot still exactly matches authoritative estimate and quote state.';
