-- StoryOps AI V1 initial schema.
-- PostgreSQL 15 / Supabase. All currency is USD numeric(12,2); measurements remain
-- numeric and are serialized as decimal strings at the application boundary.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create type public.app_role as enum ('owner', 'dispatcher', 'technician', 'customer');
create type public.approval_status as enum
  ('pending', 'approved', 'rejected', 'expired', 'cancelled');
create type public.run_status as enum
  ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled');

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 160),
  timezone text not null default 'America/Chicago',
  currency text not null default 'USD' check (currency = 'USD'),
  status text not null default 'active' check (status in ('setup', 'active', 'paused')),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  default_operational_retention_days integer not null default 1095
    check (default_operational_retention_days between 30 and 3650),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.company_memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.app_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id)
);

create index company_memberships_user_idx
  on public.company_memberships(user_id, company_id) where active;

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  source text not null check (source in ('web', 'chat', 'sms', 'phone', 'email', 'referral', 'manual')),
  status text not null default 'new'
    check (status in ('new', 'qualifying', 'qualified', 'unqualified', 'converted', 'lost')),
  display_name text not null,
  email extensions.citext,
  phone text,
  requested_services text[] not null default '{}',
  preferred_contact_channel text check (preferred_contact_channel in ('email', 'sms', 'phone')),
  qualification_summary text,
  disqualification_reason text,
  owner_user_id uuid references auth.users(id) on delete set null,
  customer_id uuid,
  property_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null default 'individual' check (kind in ('individual', 'business')),
  display_name text not null,
  given_name text,
  family_name text,
  business_name text,
  email extensions.citext,
  phone text,
  billing_address jsonb,
  lifecycle text not null default 'active'
    check (lifecycle in ('lead', 'active', 'inactive', 'blocked')),
  tags text[] not null default '{}',
  acquisition_source text,
  do_not_contact boolean not null default false,
  tax_exempt boolean not null default false,
  tax_exemption_reference text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  constraint customers_tax_exemption_proof
    check (not tax_exempt or nullif(btrim(tax_exemption_reference), '') is not null)
);

alter table public.leads
  add constraint leads_customer_fk foreign key (customer_id)
  references public.customers(id) on delete set null;

create table public.customer_portal_users (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (company_id, user_id, customer_id)
);

create index customer_portal_users_user_idx
  on public.customer_portal_users(user_id, company_id, customer_id);

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  name text not null,
  property_type text not null default 'single_family'
    check (property_type in ('single_family', 'multi_family', 'commercial', 'other')),
  service_address jsonb not null check (jsonb_typeof(service_address) = 'object'),
  access_instructions text,
  gate_code_ciphertext text,
  water_source_notes text,
  drainage_notes text,
  known_hazards text[] not null default '{}',
  stories smallint check (stories between 1 and 20),
  year_built smallint check (year_built between 1700 and 2200),
  latitude numeric(10,7),
  longitude numeric(10,7),
  geocode_confidence numeric(5,4) check (geocode_confidence between 0 and 1),
  geocoded_at timestamptz,
  last_serviced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  constraint properties_latitude check (latitude is null or latitude between -90 and 90),
  constraint properties_longitude check (longitude is null or longitude between -180 and 180)
);

alter table public.leads
  add constraint leads_property_fk foreign key (property_id)
  references public.properties(id) on delete set null;

create index properties_customer_idx on public.properties(company_id, customer_id);

create table public.consent_records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  channel text not null check (channel in ('sms', 'email', 'voice')),
  purpose text not null check (purpose in ('transactional', 'marketing')),
  status text not null check (status in ('granted', 'withdrawn', 'unknown')),
  captured_at timestamptz not null,
  capture_method text not null
    check (capture_method in ('web_form', 'keyword', 'written', 'verbal', 'imported')),
  disclosure_version text not null,
  proof text not null,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint consent_subject check (num_nonnulls(customer_id, lead_id) = 1),
  constraint consent_withdrawn_at check ((status = 'withdrawn') = (withdrawn_at is not null))
);

create table public.service_catalog (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null,
  name text not null,
  description text not null default '',
  category text not null check (
    category in ('pressure_washing', 'soft_washing', 'gutter_cleaning', 'downspout_cleaning', 'add_on')
  ),
  active boolean not null default true,
  taxable boolean not null default true,
  required_skills text[] not null default '{}',
  required_equipment_types text[] not null default '{}',
  required_measurement_kinds text[] not null default '{}',
  safety_sop_reference text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, code)
);

create table public.checklist_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  service_code text,
  version_label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, name, version_label)
);

create table public.checklist_template_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  template_id uuid not null references public.checklist_templates(id) on delete cascade,
  item_key text not null,
  label text not null,
  item_kind text not null check (item_kind in ('boolean', 'text', 'number', 'photo', 'signature')),
  required boolean not null default true,
  safety_critical boolean not null default false,
  sort_order integer not null check (sort_order >= 0),
  created_at timestamptz not null default now(),
  unique (template_id, item_key),
  unique (template_id, sort_order)
);

alter table public.service_catalog
  add column default_checklist_template_id uuid
  references public.checklist_templates(id) on delete set null;

create table public.price_books (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  version_label text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  effective_from timestamptz not null,
  effective_until timestamptz,
  currency text not null default 'USD' check (currency = 'USD'),
  company_minimum numeric(12,2) not null default 0 check (company_minimum >= 0),
  default_tax_rate_pct numeric(7,4) not null default 0 check (default_tax_rate_pct between 0 and 100),
  margin_floor_pct numeric(7,4) not null default 0 check (margin_floor_pct between 0 and 100),
  automatic_discount_limit_pct numeric(7,4) not null default 0
    check (automatic_discount_limit_pct between 0 and 100),
  deposit_kind text not null default 'none' check (deposit_kind in ('none', 'flat', 'percent')),
  deposit_value numeric(12,4) not null default 0 check (deposit_value >= 0),
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, version_label),
  constraint price_books_effective_range
    check (effective_until is null or effective_until > effective_from),
  constraint price_books_deposit_value
    check (deposit_kind <> 'percent' or deposit_value <= 100),
  constraint price_books_publication
    check ((status = 'draft') or (published_by is not null and published_at is not null))
);

create unique index price_books_one_active_idx
  on public.price_books(company_id) where status = 'active';

create table public.price_book_service_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  price_book_id uuid not null references public.price_books(id) on delete cascade,
  service_catalog_id uuid not null references public.service_catalog(id) on delete restrict,
  service_code text not null,
  pricing_unit text not null check (pricing_unit in ('flat', 'sq_ft', 'linear_ft', 'each', 'hour')),
  base_price numeric(12,2) not null check (base_price >= 0),
  unit_price numeric(12,6) not null check (unit_price >= 0),
  included_quantity numeric(14,4) not null default 0 check (included_quantity >= 0),
  service_minimum numeric(12,2) check (service_minimum is null or service_minimum >= 0),
  estimated_base_cost numeric(12,2) not null default 0 check (estimated_base_cost >= 0),
  estimated_unit_cost numeric(12,6) not null default 0 check (estimated_unit_cost >= 0),
  duration_base_minutes integer not null default 0 check (duration_base_minutes >= 0),
  duration_minutes_per_unit numeric(12,4) not null default 0
    check (duration_minutes_per_unit >= 0),
  taxable boolean not null default true,
  allowed_attribute_values jsonb not null default '{}'::jsonb
    check (jsonb_typeof(allowed_attribute_values) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (price_book_id, service_code)
);

create table public.price_book_attribute_multipliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_rule_id uuid not null references public.price_book_service_rules(id) on delete cascade,
  attribute text not null check (attribute in ('stories', 'surface', 'soil', 'access', 'risk')),
  attribute_value text not null,
  multiplier numeric(9,4) not null check (multiplier > 0),
  created_at timestamptz not null default now(),
  unique (service_rule_id, attribute, attribute_value)
);

create table public.price_book_add_ons (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_rule_id uuid not null references public.price_book_service_rules(id) on delete cascade,
  code text not null,
  name text not null,
  pricing_unit text not null check (pricing_unit in ('flat', 'sq_ft', 'linear_ft', 'each', 'hour')),
  unit_price numeric(12,6) not null check (unit_price >= 0),
  estimated_unit_cost numeric(12,6) not null default 0 check (estimated_unit_cost >= 0),
  duration_minutes_per_unit numeric(12,4) not null default 0
    check (duration_minutes_per_unit >= 0),
  taxable boolean not null default true,
  created_at timestamptz not null default now(),
  unique (service_rule_id, code)
);

create table public.price_book_travel_zones (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  price_book_id uuid not null references public.price_books(id) on delete cascade,
  zone_code text not null,
  name text not null,
  fee numeric(12,2) not null check (fee >= 0),
  taxable boolean not null default false,
  maximum_one_way_miles numeric(8,2)
    check (maximum_one_way_miles is null or maximum_one_way_miles >= 0),
  postal_codes text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (price_book_id, zone_code)
);

create table public.property_measurements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  kind text not null check (kind in ('area_sq_ft', 'length_linear_ft', 'height_ft', 'count', 'stories')),
  label text not null,
  value numeric(16,4) not null check (value > 0),
  unit text not null check (unit in ('sq_ft', 'linear_ft', 'ft', 'each', 'story')),
  source text not null check (
    source in ('field_measured', 'map', 'customer_reported', 'photo_assisted', 'imported')
  ),
  measured_at timestamptz not null,
  measured_by uuid references auth.users(id) on delete set null,
  source_asset_ids uuid[] not null default '{}',
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  verified_by_human boolean not null default false,
  supersedes_measurement_id uuid references public.property_measurements(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint photo_measurement_verification
    check (source <> 'photo_assisted' or not verified_by_human or measured_by is not null)
);

create table public.photo_analyses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  model text not null,
  model_version text not null,
  prompt_version text not null,
  purpose text not null check (purpose in ('scope', 'before', 'after', 'damage', 'safety', 'incident')),
  overall_confidence numeric(5,4) not null check (overall_confidence between 0 and 1),
  observations jsonb not null default '[]'::jsonb check (jsonb_typeof(observations) = 'array'),
  measurement_candidates jsonb not null default '[]'::jsonb
    check (jsonb_typeof(measurement_candidates) = 'array'),
  unknowns text[] not null default '{}',
  injection_signals text[] not null default '{}',
  disposition text not null
    check (disposition in ('usable_for_scope', 'human_review_required', 'insufficient')),
  analyzed_at timestamptz not null default now(),
  retention_class text not null default 'ai_trace',
  retain_until timestamptz,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.estimates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  estimate_number text not null,
  customer_id uuid not null references public.customers(id) on delete restrict,
  property_id uuid not null references public.properties(id) on delete restrict,
  lead_id uuid references public.leads(id) on delete set null,
  price_book_id uuid not null references public.price_books(id) on delete restrict,
  price_book_version text not null,
  status text not null default 'draft'
    check (status in ('draft', 'needs_input', 'pending_approval', 'approved', 'superseded')),
  service_subtotal numeric(12,2) not null default 0,
  minimum_adjustment numeric(12,2) not null default 0,
  travel_fee numeric(12,2) not null default 0,
  manual_adjustment numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  taxable_subtotal numeric(12,2) not null default 0,
  tax numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  deposit_required numeric(12,2) not null default 0,
  estimated_cost numeric(12,2) not null default 0,
  estimated_margin_pct numeric(9,4) not null default 0,
  duration_minutes integer not null default 0 check (duration_minutes >= 0),
  calculation_version text not null,
  calculation_input jsonb not null check (jsonb_typeof(calculation_input) = 'object'),
  calculation_issues jsonb not null default '[]'::jsonb check (jsonb_typeof(calculation_issues) = 'array'),
  evidence_analysis_ids uuid[] not null default '{}',
  calculated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, estimate_number),
  constraint estimates_nonnegative_totals check (
    service_subtotal >= 0 and minimum_adjustment >= 0 and travel_fee >= 0 and
    discount >= 0 and tax >= 0 and total >= 0 and deposit_required between 0 and total and
    estimated_cost >= 0
  )
);

create table public.estimate_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  estimate_id uuid not null references public.estimates(id) on delete cascade,
  line_kind text not null check (
    line_kind in ('service', 'add_on', 'company_minimum', 'travel', 'manual_adjustment')
  ),
  service_code text,
  add_on_code text,
  description text not null,
  quantity numeric(16,4) not null,
  unit text not null,
  unit_price numeric(12,6) not null,
  multiplier numeric(9,4) not null default 1 check (multiplier > 0),
  subtotal numeric(12,2) not null,
  taxable boolean not null default true,
  estimated_cost numeric(12,2) not null default 0 check (estimated_cost >= 0),
  source_measurement_ids uuid[] not null default '{}',
  sort_order integer not null check (sort_order >= 0),
  created_at timestamptz not null default now(),
  unique (estimate_id, sort_order)
);

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  quote_number text not null,
  estimate_id uuid not null references public.estimates(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  property_id uuid not null references public.properties(id) on delete restrict,
  status text not null default 'draft' check (
    status in ('draft', 'pending_approval', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'void')
  ),
  valid_until date not null,
  terms_version text not null,
  terms_snapshot text not null,
  total numeric(12,2) not null check (total >= 0),
  deposit_required numeric(12,2) not null check (deposit_required >= 0 and deposit_required <= total),
  sent_at timestamptz,
  accepted_at timestamptz,
  accepted_by_name text,
  accepted_by_user_id uuid references auth.users(id) on delete set null,
  acceptance_ip_hash text,
  acceptance_context_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, quote_number),
  constraint quotes_acceptance_evidence check (
    status <> 'accepted'
    or (
      accepted_at is not null
      and nullif(btrim(accepted_by_name), '') is not null
      and accepted_by_user_id is not null
      and acceptance_context_hash ~ '^[a-f0-9]{64}$'
      and (
        acceptance_ip_hash is null
        or acceptance_ip_hash ~ '^[a-f0-9]{64}$'
      )
    )
  )
);

create table public.crews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  lead_technician_id uuid references auth.users(id) on delete set null,
  skill_codes text[] not null default '{}',
  home_base_postal_code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, name)
);

create table public.crew_members (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  crew_id uuid not null references public.crews(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  starts_on date not null default current_date,
  ends_on date,
  created_at timestamptz not null default now(),
  unique (crew_id, user_id, starts_on),
  check (ends_on is null or ends_on >= starts_on)
);

create index crew_members_active_user_idx
  on public.crew_members(company_id, user_id, crew_id) where ends_on is null;

create table public.equipment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  asset_tag text not null,
  name text not null,
  equipment_type text not null,
  status text not null check (status in ('available', 'assigned', 'maintenance', 'retired')),
  assigned_crew_id uuid references public.crews(id) on delete set null,
  last_inspection_at timestamptz,
  next_inspection_due date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, asset_tag)
);

create table public.sds_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_name text not null,
  manufacturer text not null,
  revision_date date not null,
  storage_object_path text not null,
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, checksum_sha256)
);

create table public.materials (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  sku text not null,
  name text not null,
  unit text not null check (unit in ('oz', 'gal', 'lb', 'each')),
  quantity_on_hand numeric(14,4) not null default 0 check (quantity_on_hand >= 0),
  reorder_point numeric(14,4) not null default 0 check (reorder_point >= 0),
  sds_document_id uuid references public.sds_documents(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, sku)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_number text not null,
  quote_id uuid not null references public.quotes(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  property_id uuid not null references public.properties(id) on delete restrict,
  status text not null default 'pending_deposit' check (
    status in ('pending_deposit', 'ready_to_schedule', 'scheduled', 'in_progress', 'completed', 'invoiced', 'cancelled')
  ),
  priority text not null default 'routine' check (priority in ('routine', 'high', 'urgent')),
  service_codes text[] not null default '{}',
  estimated_duration_minutes integer not null check (estimated_duration_minutes >= 0),
  estimated_revenue numeric(12,2) not null check (estimated_revenue >= 0),
  estimated_cost numeric(12,2) not null check (estimated_cost >= 0),
  assigned_crew_id uuid references public.crews(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, job_number)
);

create table public.route_checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null check (provider in ('vroom', 'mock')),
  checked_at timestamptz not null,
  route_feasible boolean not null,
  drive_minutes integer not null check (drive_minutes >= 0),
  added_distance_miles numeric(10,2) not null check (added_distance_miles >= 0),
  violations text[] not null default '{}',
  request_payload jsonb not null,
  response_payload jsonb not null,
  created_at timestamptz not null default now()
);

create table public.weather_checks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  provider text not null check (provider in ('nws', 'mock')),
  forecast_issued_at timestamptz not null,
  checked_at timestamptz not null,
  period_starts_at timestamptz not null,
  period_ends_at timestamptz not null,
  temperature_f numeric(6,2) not null,
  precipitation_probability numeric(5,4) not null check (precipitation_probability between 0 and 1),
  wind_speed_mph numeric(7,2) not null check (wind_speed_mph >= 0),
  lightning_risk text not null check (lightning_risk in ('none', 'low', 'elevated', 'severe', 'unknown')),
  condition_codes text[] not null default '{}',
  policy_disposition text not null check (policy_disposition in ('eligible', 'requires_approval', 'unavailable')),
  raw_forecast jsonb not null,
  created_at timestamptz not null default now(),
  check (period_ends_at > period_starts_at)
);

create table public.visits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  status text not null default 'planned' check (
    status in ('planned', 'confirmed', 'en_route', 'on_site', 'paused', 'completed', 'cancelled', 'weather_hold')
  ),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  crew_id uuid not null references public.crews(id) on delete restrict,
  route_check_id uuid references public.route_checks(id) on delete set null,
  weather_check_id uuid references public.weather_checks(id) on delete set null,
  checklist_template_id uuid not null references public.checklist_templates(id) on delete restrict,
  internal_notes text,
  customer_notes text,
  offline_revision integer not null default 0 check (offline_revision >= 0),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (job_id, sequence),
  check (ends_at > starts_at)
);

create index visits_schedule_idx on public.visits(company_id, starts_at, ends_at);
create index visits_crew_schedule_idx on public.visits(crew_id, starts_at, ends_at);

create table public.dispatch_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete cascade,
  crew_id uuid not null references public.crews(id) on delete restrict,
  assigned_by uuid not null references auth.users(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  route_position integer check (route_position is null or route_position >= 0),
  status text not null check (status in ('proposed', 'confirmed', 'changed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (ends_at > starts_at)
);

create table public.visit_checklist_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete cascade,
  template_item_id uuid not null references public.checklist_template_items(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'complete', 'not_applicable', 'blocked')),
  value jsonb,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  evidence_asset_ids uuid[] not null default '{}',
  note text,
  offline_client_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (visit_id, template_item_id),
  constraint visit_checklist_completion check (
    status <> 'complete' or (completed_at is not null and completed_by is not null)
  )
);

create unique index visit_checklist_items_offline_client_idx
  on public.visit_checklist_items(visit_id, offline_client_id)
  where offline_client_id is not null;

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete restrict,
  started_at timestamptz not null,
  ended_at timestamptz,
  break_minutes integer not null default 0 check (break_minutes >= 0),
  source text not null check (source in ('field_app', 'manual_adjustment')),
  approved_by uuid references auth.users(id) on delete set null,
  offline_client_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (ended_at is null or ended_at > started_at),
  check (source <> 'manual_adjustment' or approved_by is not null)
);

create unique index time_entries_offline_client_idx
  on public.time_entries(visit_id, offline_client_id)
  where offline_client_id is not null;
create unique index time_entries_one_open_idx
  on public.time_entries(visit_id, user_id)
  where ended_at is null;

create table public.material_usage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete cascade,
  material_id uuid not null references public.materials(id) on delete restrict,
  quantity numeric(14,4) not null check (quantity > 0),
  unit text not null check (unit in ('oz', 'gal', 'lb', 'each')),
  recorded_at timestamptz not null,
  recorded_by uuid not null references auth.users(id) on delete restrict,
  offline_client_id text,
  created_at timestamptz not null default now(),
  check (length(offline_client_id) > 0 or offline_client_id is null)
);

create unique index material_usage_offline_client_idx
  on public.material_usage(visit_id, offline_client_id)
  where offline_client_id is not null;

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  property_id uuid references public.properties(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  visit_id uuid references public.visits(id) on delete cascade,
  incident_id uuid,
  purpose text not null check (purpose in ('scope', 'before', 'after', 'damage', 'safety', 'incident', 'signature')),
  object_path text not null,
  content_type text not null,
  byte_size bigint not null check (byte_size > 0 and byte_size <= 26214400),
  checksum_sha256 text not null check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz not null,
  captured_by uuid references auth.users(id) on delete set null,
  customer_visible boolean not null default false,
  offline_client_id text,
  sync_state text not null default 'synced' check (sync_state in ('pending', 'synced', 'failed')),
  retention_class text not null default 'operational',
  retain_until timestamptz,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, object_path),
  check (length(offline_client_id) > 0 or offline_client_id is null)
);

create unique index media_assets_offline_client_idx
  on public.media_assets(company_id, offline_client_id)
  where offline_client_id is not null;

create table public.completion_signatures (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  visit_id uuid not null references public.visits(id) on delete cascade,
  signer_name text not null,
  signer_role text not null check (signer_role in ('customer', 'technician')),
  signed_at timestamptz not null,
  signature_asset_id uuid not null references public.media_assets(id) on delete restrict,
  disclosure_version text not null,
  created_at timestamptz not null default now(),
  unique (visit_id, signer_role)
);

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  incident_number text not null,
  job_id uuid references public.jobs(id) on delete set null,
  visit_id uuid references public.visits(id) on delete set null,
  property_id uuid references public.properties(id) on delete set null,
  severity text not null check (severity in ('near_miss', 'minor', 'serious', 'critical')),
  status text not null check (status in ('open', 'investigating', 'corrective_action', 'closed')),
  category text not null check (category in ('injury', 'property_damage', 'chemical', 'vehicle', 'environmental', 'other')),
  occurred_at timestamptz not null,
  reported_at timestamptz not null,
  reported_by uuid not null references auth.users(id) on delete restrict,
  summary text not null,
  immediate_actions text not null,
  owner_notified_at timestamptz,
  requires_legal_review boolean not null default false,
  closed_at timestamptz,
  closed_by uuid references auth.users(id) on delete set null,
  retention_class text not null default 'safety',
  retain_until timestamptz,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, incident_number),
  check (status <> 'closed' or (closed_at is not null and closed_by is not null))
);

alter table public.media_assets
  add constraint media_assets_incident_fk foreign key (incident_id)
  references public.incidents(id) on delete cascade;

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_number text not null,
  customer_id uuid not null references public.customers(id) on delete restrict,
  job_id uuid references public.jobs(id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'open', 'paid', 'past_due', 'void', 'uncollectible')),
  provider_invoice_id text,
  issue_date date not null,
  due_date date not null,
  subtotal numeric(12,2) not null check (subtotal >= 0),
  tax numeric(12,2) not null check (tax >= 0),
  total numeric(12,2) not null check (total >= 0),
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  balance_due numeric(12,2) not null check (balance_due >= 0),
  sent_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, invoice_number),
  unique (company_id, provider_invoice_id),
  check (due_date >= issue_date),
  check (total = subtotal + tax),
  check (balance_due = total - amount_paid)
);

create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  description text not null,
  quantity numeric(14,4) not null check (quantity > 0),
  unit_price numeric(12,6) not null check (unit_price >= 0),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  taxable boolean not null default true,
  sort_order integer not null check (sort_order >= 0),
  created_at timestamptz not null default now(),
  unique (invoice_id, sort_order)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  provider text not null check (provider in ('stripe', 'cash', 'check', 'other')),
  provider_payment_id text,
  payment_type text not null check (payment_type in ('deposit', 'invoice', 'refund')),
  status text not null check (status in ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded')),
  amount numeric(12,2) not null check (amount > 0),
  processed_at timestamptz,
  failure_code text,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, provider, provider_payment_id),
  unique (company_id, idempotency_key)
);

create table public.communication_threads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  subject text,
  status text not null default 'open' check (status in ('open', 'waiting', 'closed')),
  assigned_user_id uuid references auth.users(id) on delete set null,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (num_nonnulls(customer_id, lead_id) >= 1)
);

create table public.communication_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  thread_id uuid not null references public.communication_threads(id) on delete cascade,
  channel text not null check (channel in ('sms', 'email', 'voice', 'chat', 'portal')),
  direction text not null check (direction in ('inbound', 'outbound')),
  sender text not null,
  recipients text[] not null default '{}',
  body text not null,
  risk_class text not null default 'routine'
    check (risk_class in ('routine', 'legal', 'safety')),
  provider_message_id text,
  delivery_status text not null check (delivery_status in ('queued', 'sent', 'delivered', 'failed', 'received')),
  consent_record_id uuid references public.consent_records(id) on delete set null,
  sent_by_user_id uuid references auth.users(id) on delete set null,
  sent_by_agent text,
  approval_request_id uuid,
  received_at timestamptz,
  sent_at timestamptz,
  retention_class text not null default 'communication',
  retain_until timestamptz,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, channel, provider_message_id),
  check (num_nonnulls(sent_by_user_id, sent_by_agent) <= 1)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  channel text not null check (channel in ('sms', 'email')),
  status text not null check (status in ('draft', 'pending_approval', 'scheduled', 'running', 'paused', 'complete')),
  audience_definition jsonb not null check (jsonb_typeof(audience_definition) = 'object'),
  template_version text not null,
  scheduled_at timestamptz,
  sent_count integer not null default 0 check (sent_count >= 0),
  delivered_count integer not null default 0 check (delivered_count >= 0),
  opt_out_count integer not null default 0 check (opt_out_count >= 0),
  approval_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  consent_record_id uuid not null references public.consent_records(id) on delete restrict,
  status text not null check (status in ('pending', 'sent', 'delivered', 'failed', 'opted_out', 'suppressed')),
  provider_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, customer_id)
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  provider text not null check (provider in ('google', 'facebook', 'internal', 'other')),
  provider_review_id text,
  rating smallint not null check (rating between 1 and 5),
  body text,
  received_at timestamptz not null,
  sentiment text not null check (sentiment in ('positive', 'neutral', 'negative', 'unknown')),
  response_status text not null
    check (response_status in ('not_needed', 'drafted', 'pending_approval', 'posted')),
  response_text text,
  approval_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, provider, provider_review_id)
);

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  referrer_customer_id uuid not null references public.customers(id) on delete cascade,
  referred_lead_id uuid references public.leads(id) on delete set null,
  referred_customer_id uuid references public.customers(id) on delete set null,
  status text not null check (status in ('invited', 'converted', 'reward_pending', 'rewarded', 'expired')),
  reward_description text,
  converted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table public.recurring_maintenance_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  service_codes text[] not null,
  cadence text not null check (cadence in ('monthly', 'quarterly', 'semiannual', 'annual', 'custom')),
  interval_days integer check (interval_days is null or interval_days > 0),
  next_due_date date not null,
  status text not null check (status in ('proposed', 'active', 'paused', 'ended')),
  price_book_id uuid not null references public.price_books(id) on delete restrict,
  requires_fresh_estimate boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check ((cadence = 'custom') = (interval_days is not null))
);

create table public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  reason text not null check (reason in (
    'price_exception', 'large_discount', 'margin_below_floor', 'refund', 'legal_message',
    'safety_message', 'negative_review_response', 'vendor_action', 'bank_action',
    'destructive_change', 'outside_price_book', 'outside_sop', 'uncertain_scope',
    'stale_availability', 'weather_exception', 'campaign_send', 'other'
  )),
  risk_level text not null check (risk_level in ('low', 'medium', 'high', 'critical')),
  status public.approval_status not null default 'pending',
  requested_by_type text not null check (requested_by_type in ('user', 'customer', 'agent', 'system', 'provider')),
  requested_by_id text not null,
  requested_at timestamptz not null default now(),
  expires_at timestamptz,
  entity_type text not null,
  entity_id uuid,
  action_type text not null,
  action_payload jsonb not null,
  summary text not null,
  policy_version text not null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  consumed_at timestamptz,
  execution_receipt jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (
    (status = 'pending' and decided_by is null and decided_at is null) or
    (status <> 'pending' and decided_at is not null)
  ),
  check (
    (consumed_at is null and execution_receipt is null)
    or (
      status = 'approved'
      and consumed_at is not null
      and jsonb_typeof(execution_receipt) = 'object'
    )
  )
);

alter table public.communication_messages
  add constraint communication_messages_approval_fk foreign key (approval_request_id)
  references public.approval_requests(id) on delete set null;
alter table public.campaigns
  add constraint campaigns_approval_fk foreign key (approval_request_id)
  references public.approval_requests(id) on delete set null;
alter table public.reviews
  add constraint reviews_approval_fk foreign key (approval_request_id)
  references public.approval_requests(id) on delete set null;
alter table public.payments
  add column approval_request_id uuid
  references public.approval_requests(id) on delete restrict;

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  automation_key text not null,
  trigger_type text not null check (trigger_type in ('event', 'schedule', 'manual', 'webhook')),
  trigger_reference text,
  status public.run_status not null default 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  idempotency_key text not null,
  attempt integer not null default 1 check (attempt between 1 and 20),
  input jsonb not null,
  output jsonb,
  error_code text,
  error_message text,
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, automation_key, idempotency_key, attempt)
);

create table public.ai_traces (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  trace_id text not null,
  span_id text not null,
  parent_span_id text,
  agent text not null check (agent in (
    'orchestrator', 'intake', 'estimating', 'scheduling', 'follow_up',
    'marketing', 'finance', 'safety', 'briefing'
  )),
  operation text not null,
  status text not null check (status in ('started', 'succeeded', 'failed', 'guardrail_blocked', 'approval_required')),
  model text,
  prompt_version text not null,
  tool_name text,
  started_at timestamptz not null,
  ended_at timestamptz,
  input_redacted jsonb not null,
  output_redacted jsonb,
  guardrail_results jsonb not null default '[]'::jsonb,
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  cost_micros bigint check (cost_micros is null or cost_micros >= 0),
  retention_class text not null default 'ai_trace',
  retain_until timestamptz,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  unique (company_id, trace_id, span_id)
);

create index ai_traces_trace_idx on public.ai_traces(company_id, trace_id, started_at);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user', 'customer', 'agent', 'system', 'provider')),
  actor_id text not null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  request_id text,
  trace_id text,
  source_ip_hash text,
  retention_class text not null default 'audit',
  retain_until timestamptz,
  legal_hold boolean not null default false
);

create index audit_events_entity_idx
  on public.audit_events(company_id, entity_type, entity_id, occurred_at desc);
create index audit_events_time_idx on public.audit_events(company_id, occurred_at desc);

create table public.owner_briefings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  briefing_date date not null,
  period_starts_at timestamptz not null,
  period_ends_at timestamptz not null,
  status text not null check (status in ('draft', 'ready', 'delivered')),
  sections jsonb not null check (jsonb_typeof(sections) = 'array'),
  generated_by_run_id uuid not null references public.automation_runs(id) on delete restrict,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, briefing_date),
  check (period_ends_at > period_starts_at)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  recipient_user_id uuid references auth.users(id) on delete cascade,
  recipient_customer_id uuid references public.customers(id) on delete cascade,
  kind text not null check (kind in ('approval_required', 'booking_changed', 'weather_alert', 'payment', 'incident', 'integration', 'system')),
  title text not null,
  body text not null,
  action_url text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (num_nonnulls(recipient_user_id, recipient_customer_id) = 1)
);

create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null check (provider in (
    'openai', 'twilio', 'email', 'stripe', 'google_calendar', 'maps',
    'nws', 'vroom', 'storage', 'signed_storage_targets', 'quickbooks_export'
  )),
  mode text not null default 'disabled' check (mode in ('disabled', 'sandbox', 'live')),
  status text not null default 'disabled' check (status in ('healthy', 'degraded', 'misconfigured', 'disabled')),
  secret_reference text,
  configuration jsonb not null default '{}'::jsonb,
  capabilities text[] not null default '{}',
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, provider),
  check (mode = 'disabled' or secret_reference is not null or mode = 'sandbox')
);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  provider text not null check (length(btrim(provider)) between 1 and 80),
  provider_event_id text not null check (length(btrim(provider_event_id)) between 1 and 255),
  event_type text not null check (length(btrim(event_type)) between 1 and 255),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'received'
    check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  signature_verified_at timestamptz not null default now(),
  raw_payload_retain_until timestamptz not null default (now() + interval '7 days'),
  payload_purged_at timestamptz,
  receipt_retain_until timestamptz not null default (now() + interval '24 months'),
  legal_hold boolean not null default false,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 50),
  last_error text,
  unique (provider, provider_event_id),
  check (raw_payload_retain_until >= received_at),
  check (receipt_retain_until >= raw_payload_retain_until),
  check ((payload_purged_at is null) or payload = '{}'::jsonb),
  check (
    (status in ('processed', 'ignored') and processed_at is not null)
    or status in ('received', 'processing', 'failed')
  )
);

create index webhook_events_processing_idx
  on public.webhook_events(status, received_at) where status in ('received', 'failed');

create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  scope text not null,
  key text not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'in_progress'
    check (status in ('in_progress', 'completed', 'failed')),
  response jsonb,
  error_code text,
  locked_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, scope, key),
  check (expires_at > created_at),
  check (status <> 'completed' or response is not null)
);

create index idempotency_expiry_idx on public.idempotency_keys(expires_at);

create table public.retention_policies (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  version_label text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  effective_from timestamptz not null,
  class_rules jsonb not null check (
    jsonb_typeof(class_rules) = 'object'
    and class_rules ?& array['operational', 'communication', 'ai_trace', 'audit', 'safety']
  ),
  legal_review_status text not null default 'required'
    check (legal_review_status in ('required', 'approved')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, version_label),
  check (
    status = 'draft'
    or (
      approved_by is not null
      and approved_at is not null
      and legal_review_status = 'approved'
    )
  )
);

create unique index retention_policies_one_active_idx
  on public.retention_policies(company_id) where status = 'active';

create table public.retention_runs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  retention_policy_id uuid not null references public.retention_policies(id) on delete restrict,
  approval_request_id uuid references public.approval_requests(id) on delete restrict,
  cutoff_at timestamptz not null,
  dry_run boolean not null,
  status text not null check (status in ('planned', 'succeeded', 'failed')),
  candidate_counts jsonb not null check (jsonb_typeof(candidate_counts) = 'object'),
  affected_counts jsonb not null check (jsonb_typeof(affected_counts) = 'object'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  executed_by text not null,
  executed_at timestamptz not null default now(),
  error_code text,
  created_at timestamptz not null default now(),
  check ((dry_run and approval_request_id is null) or (not dry_run and approval_request_id is not null)),
  check ((status = 'failed') = (error_code is not null))
);

create table public.search_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  title text not null,
  body text not null default '',
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, entity_type, entity_id)
);

create index search_documents_vector_idx on public.search_documents using gin(search_vector);
create index search_documents_title_trgm_idx
  on public.search_documents using gin(title extensions.gin_trgm_ops);

-- Every tenant-owned foreign key must point to a row owned by the same company.
-- Plain UUID foreign keys alone do not prevent a caller from linking a row they
-- can write in company A to a guessed UUID in company B.
create or replace function public.assert_same_company_reference()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  source_company_id uuid;
  referenced_id uuid;
  referenced_company_id uuid;
begin
  source_company_id := (to_jsonb(new) ->> 'company_id')::uuid;
  referenced_id := nullif(to_jsonb(new) ->> tg_argv[0], '')::uuid;
  if referenced_id is null then
    return new;
  end if;

  execute format(
    'select company_id from public.%I where id = $1',
    tg_argv[1]
  )
  into referenced_company_id
  using referenced_id;

  -- The ordinary foreign key reports a missing target. This trigger adds the
  -- tenant invariant without replacing referential actions.
  if referenced_company_id is not null and referenced_company_id <> source_company_id then
    raise exception using
      errcode = '23514',
      message = format(
        'Cross-company reference rejected: %s.%s -> %s',
        tg_table_name,
        tg_argv[0],
        tg_argv[1]
      );
  end if;
  return new;
end;
$$;

revoke all on function public.assert_same_company_reference() from public;

do $$
declare
  reference record;
  trigger_name text;
begin
  for reference in
    select
      source_table.relname as source_table,
      source_column.attname as source_column,
      target_table.relname as target_table,
      constraint_row.conname
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class source_table
      on source_table.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace source_namespace
      on source_namespace.oid = source_table.relnamespace
    join pg_catalog.pg_class target_table
      on target_table.oid = constraint_row.confrelid
    join pg_catalog.pg_namespace target_namespace
      on target_namespace.oid = target_table.relnamespace
    join pg_catalog.pg_attribute source_column
      on source_column.attrelid = constraint_row.conrelid
      and source_column.attnum = constraint_row.conkey[1]
    join pg_catalog.pg_attribute target_column
      on target_column.attrelid = constraint_row.confrelid
      and target_column.attnum = constraint_row.confkey[1]
    where constraint_row.contype = 'f'
      and cardinality(constraint_row.conkey) = 1
      and cardinality(constraint_row.confkey) = 1
      and source_namespace.nspname = 'public'
      and target_namespace.nspname = 'public'
      and target_column.attname = 'id'
      and source_column.attname <> 'company_id'
      and exists (
        select 1
        from pg_catalog.pg_attribute company_column
        where company_column.attrelid = source_table.oid
          and company_column.attname = 'company_id'
          and not company_column.attisdropped
      )
      and exists (
        select 1
        from pg_catalog.pg_attribute company_column
        where company_column.attrelid = target_table.oid
          and company_column.attname = 'company_id'
          and not company_column.attisdropped
      )
  loop
    trigger_name := 'tenant_integrity_' || substr(
      md5(reference.source_table || ':' || reference.conname),
      1,
      20
    );
    execute format(
      'create constraint trigger %I after insert or update on public.%I deferrable initially immediate for each row execute function public.assert_same_company_reference(%L, %L)',
      trigger_name,
      reference.source_table,
      reference.source_column,
      reference.target_table
    );
  end loop;
end;
$$;

create or replace function public.assert_same_company_reference_array()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  source_company_id uuid;
  references_json jsonb;
  invalid_reference boolean;
begin
  source_company_id := (to_jsonb(new) ->> 'company_id')::uuid;
  references_json := coalesce(to_jsonb(new) -> tg_argv[0], '[]'::jsonb);
  execute format(
    'select exists (
       select 1
       from jsonb_array_elements_text($1) item(reference_id)
       left join public.%I target on target.id = item.reference_id::uuid
       where target.id is null or target.company_id <> $2
     )',
    tg_argv[1]
  )
  into invalid_reference
  using references_json, source_company_id;
  if invalid_reference then
    raise exception using
      errcode = '23514',
      message = format(
        'Missing or cross-company evidence reference rejected: %s.%s -> %s',
        tg_table_name,
        tg_argv[0],
        tg_argv[1]
      );
  end if;
  return new;
end;
$$;

revoke all on function public.assert_same_company_reference_array() from public;

create constraint trigger property_measurements_source_assets_tenant_integrity
  after insert or update on public.property_measurements
  deferrable initially immediate
  for each row execute function public.assert_same_company_reference_array(
    'source_asset_ids',
    'media_assets'
  );
create constraint trigger estimates_evidence_analyses_tenant_integrity
  after insert or update on public.estimates
  deferrable initially immediate
  for each row execute function public.assert_same_company_reference_array(
    'evidence_analysis_ids',
    'photo_analyses'
  );
create constraint trigger estimate_lines_source_measurements_tenant_integrity
  after insert or update on public.estimate_lines
  deferrable initially immediate
  for each row execute function public.assert_same_company_reference_array(
    'source_measurement_ids',
    'property_measurements'
  );
create constraint trigger visit_checklist_evidence_assets_tenant_integrity
  after insert or update on public.visit_checklist_items
  deferrable initially immediate
  for each row execute function public.assert_same_company_reference_array(
    'evidence_asset_ids',
    'media_assets'
  );

-- Authentication and tenant helpers.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create or replace function public.is_company_member(target_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.company_memberships m
    where m.company_id = target_company_id and m.user_id = auth.uid() and m.active
  );
$$;

create or replace function public.has_company_role(
  target_company_id uuid,
  allowed_roles public.app_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.company_memberships m
    where m.company_id = target_company_id
      and m.user_id = auth.uid()
      and m.active
      and m.role = any(allowed_roles)
  );
$$;

create or replace function public.is_customer_user(
  target_company_id uuid,
  target_customer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.customer_portal_users p
    where p.company_id = target_company_id
      and p.customer_id = target_customer_id
      and p.user_id = auth.uid()
  );
$$;

create or replace function public.is_assigned_technician_for_job(target_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.jobs j
    join public.crew_members cm on cm.crew_id = j.assigned_crew_id
    where j.id = target_job_id
      and cm.user_id = auth.uid()
      and cm.starts_on <= current_date
      and (cm.ends_on is null or cm.ends_on >= current_date)
  );
$$;

create or replace function public.is_assigned_technician_for_visit(target_visit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.visits v
    join public.crew_members cm on cm.crew_id = v.crew_id
    where v.id = target_visit_id
      and cm.user_id = auth.uid()
      and cm.starts_on <= v.ends_at::date
      and (cm.ends_on is null or cm.ends_on >= v.starts_at::date)
  );
$$;

revoke all on function public.is_company_member(uuid) from public;
revoke all on function public.has_company_role(uuid, public.app_role[]) from public;
revoke all on function public.is_customer_user(uuid, uuid) from public;
revoke all on function public.is_assigned_technician_for_job(uuid) from public;
revoke all on function public.is_assigned_technician_for_visit(uuid) from public;
grant execute on function public.is_company_member(uuid) to authenticated, service_role;
grant execute on function public.has_company_role(uuid, public.app_role[]) to authenticated, service_role;
grant execute on function public.is_customer_user(uuid, uuid) to authenticated, service_role;
grant execute on function public.is_assigned_technician_for_job(uuid) to authenticated, service_role;
grant execute on function public.is_assigned_technician_for_visit(uuid) to authenticated, service_role;

create or replace function public.protect_last_active_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.role = 'owner'
    and old.active
    and (
      tg_op = 'DELETE'
      or new.role <> 'owner'
      or not new.active
      or new.company_id <> old.company_id
    )
    and exists (select 1 from public.companies where id = old.company_id)
    and not exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = old.company_id
        and membership.role = 'owner'
        and membership.active
    )
  then
    raise exception using
      errcode = '23514',
      message = 'A company must retain at least one active owner';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create constraint trigger company_memberships_last_owner
  after update or delete on public.company_memberships
  deferrable initially immediate
  for each row execute function public.protect_last_active_owner();

create or replace function public.enforce_portal_membership()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = new.company_id
      and membership.user_id = new.user_id
      and membership.role = 'customer'
      and membership.active
  ) then
    raise exception using
      errcode = '23514',
      message = 'Portal mapping requires an active customer membership in the same company';
  end if;
  return new;
end;
$$;

create trigger customer_portal_users_membership
  before insert or update on public.customer_portal_users
  for each row execute function public.enforce_portal_membership();

-- Record freshness and optimistic versioning.
create or replace function public.touch_record()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  if to_jsonb(new) ? 'version' then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'companies', 'profiles', 'company_memberships', 'leads', 'customers', 'properties',
    'consent_records', 'service_catalog', 'checklist_templates', 'price_books',
    'price_book_service_rules', 'property_measurements', 'estimates', 'quotes', 'crews',
    'equipment', 'sds_documents', 'materials', 'jobs', 'visits', 'dispatch_assignments',
    'visit_checklist_items', 'time_entries', 'media_assets', 'incidents', 'invoices',
    'payments', 'communication_threads', 'communication_messages', 'campaigns',
    'campaign_recipients', 'reviews', 'referrals', 'recurring_maintenance_plans',
    'approval_requests', 'automation_runs', 'owner_briefings', 'notifications',
    'integration_connections', 'idempotency_keys', 'retention_policies', 'search_documents'
  ]
  loop
    execute format(
      'create trigger %I_touch before update on public.%I for each row execute function public.touch_record()',
      table_name,
      table_name
    );
  end loop;
end;
$$;

-- Published price books and their child rules are immutable.
create or replace function public.protect_published_price_book()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_status text;
  source_price_book_id uuid;
begin
  if tg_table_name = 'price_books' then
    if tg_op = 'DELETE' then
      if old.status in ('active', 'retired') then
        raise exception 'Published price books cannot be deleted';
      end if;
      return old;
    end if;
    if old.status in ('active', 'retired') then
      if not (
        old.status = 'active'
        and new.status = 'retired'
        and (to_jsonb(new) - array['status', 'updated_at', 'version'])
          = (to_jsonb(old) - array['status', 'updated_at', 'version'])
      ) then
        raise exception 'Published price books are immutable; create a new version';
      end if;
    end if;
    return new;
  end if;

  source_price_book_id := case
    when tg_op = 'DELETE' then old.price_book_id
    else new.price_book_id
  end;
  select status into parent_status from public.price_books where id = source_price_book_id;
  if parent_status in ('active', 'retired') then
    raise exception 'Rules belonging to a published price book are immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger price_books_immutable
  before update or delete on public.price_books
  for each row execute function public.protect_published_price_book();
create trigger price_book_service_rules_immutable
  before insert or update or delete on public.price_book_service_rules
  for each row execute function public.protect_published_price_book();

create or replace function public.protect_price_book_child_by_rule()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_status text;
  source_rule_id uuid;
begin
  source_rule_id := case when tg_op = 'DELETE' then old.service_rule_id else new.service_rule_id end;
  select pb.status into parent_status
  from public.price_book_service_rules sr
  join public.price_books pb on pb.id = sr.price_book_id
  where sr.id = source_rule_id;
  if parent_status in ('active', 'retired') then
    raise exception 'Rules belonging to a published price book are immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger price_book_attribute_multipliers_immutable
  before insert or update or delete on public.price_book_attribute_multipliers
  for each row execute function public.protect_price_book_child_by_rule();
create trigger price_book_add_ons_immutable
  before insert or update or delete on public.price_book_add_ons
  for each row execute function public.protect_price_book_child_by_rule();

create or replace function public.protect_travel_zone()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_status text;
  source_price_book_id uuid;
begin
  source_price_book_id := case when tg_op = 'DELETE' then old.price_book_id else new.price_book_id end;
  select status into parent_status from public.price_books where id = source_price_book_id;
  if parent_status in ('active', 'retired') then
    raise exception 'Travel zones belonging to a published price book are immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger price_book_travel_zones_immutable
  before insert or update or delete on public.price_book_travel_zones
  for each row execute function public.protect_travel_zone();

create or replace function public.protect_retention_policy()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Retention policies cannot be deleted';
  end if;
  if old.status in ('active', 'retired') and not (
    old.status = 'active'
    and new.status = 'retired'
    and (
      to_jsonb(new) - array['status', 'updated_at', 'version']
      = to_jsonb(old) - array['status', 'updated_at', 'version']
    )
  ) then
    raise exception 'Published retention policies are immutable; create a new version';
  end if;
  return new;
end;
$$;

create trigger retention_policies_immutable
  before update or delete on public.retention_policies
  for each row execute function public.protect_retention_policy();

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table private.storyops_approval_consumption_capabilities (
  backend_pid integer not null,
  transaction_id bigint not null,
  company_id uuid not null,
  approval_request_id uuid not null,
  token uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (backend_pid, transaction_id, approval_request_id)
);

revoke all on table private.storyops_approval_consumption_capabilities
  from public, anon, authenticated, service_role;

create or replace function private.authorize_storyops_approval_consumption(
  p_company_id uuid,
  p_approval_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private, extensions
as $$
declare
  capability_token uuid := extensions.gen_random_uuid();
begin
  insert into private.storyops_approval_consumption_capabilities(
    backend_pid,
    transaction_id,
    company_id,
    approval_request_id,
    token
  )
  values (
    pg_backend_pid(),
    txid_current(),
    p_company_id,
    p_approval_request_id,
    capability_token
  );
  perform set_config(
    'storyops.approval_consumption_token',
    capability_token::text,
    true
  );
end;
$$;

revoke all on function private.authorize_storyops_approval_consumption(
  uuid, uuid
) from public, anon, authenticated, service_role;

create or replace function public.protect_approval_request()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  immutable_old jsonb;
  immutable_new jsonb;
  capability_setting text;
  capability_token uuid;
begin
  immutable_old := to_jsonb(old) - array[
    'status', 'decided_by', 'decided_at', 'decision_note',
    'consumed_at', 'execution_receipt', 'updated_at', 'version'
  ];
  immutable_new := to_jsonb(new) - array[
    'status', 'decided_by', 'decided_at', 'decision_note',
    'consumed_at', 'execution_receipt', 'updated_at', 'version'
  ];
  if immutable_new <> immutable_old then
    raise exception 'Approval scope and exact action payload are immutable';
  end if;

  if old.status <> 'pending' and (
    new.status <> old.status
    or new.decided_by is distinct from old.decided_by
    or new.decided_at is distinct from old.decided_at
    or new.decision_note is distinct from old.decision_note
  ) then
    raise exception 'An approval decision is final';
  end if;

  if old.status = 'pending' and new.status <> 'pending' then
    if new.status in ('approved', 'rejected') and not exists (
      select 1
      from public.company_memberships membership
      where membership.company_id = old.company_id
        and membership.user_id = new.decided_by
        and membership.role = 'owner'
        and membership.active
    ) then
      raise exception 'Approval decisions require an active owner';
    end if;
  elsif old.status = 'pending' and new.status = 'pending' and (
    new.decided_by is not null
    or new.decided_at is not null
    or new.decision_note is not null
  ) then
    raise exception 'Pending approvals cannot contain decision evidence';
  end if;

  if (
    new.consumed_at is distinct from old.consumed_at
    or new.execution_receipt is distinct from old.execution_receipt
  ) then
    capability_setting := current_setting(
      'storyops.approval_consumption_token',
      true
    );
    if capability_setting ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then
      capability_token := capability_setting::uuid;
    end if;
    if capability_token is null or not exists (
      select 1
      from private.storyops_approval_consumption_capabilities capability
      where capability.backend_pid = pg_backend_pid()
        and capability.transaction_id = txid_current()
        and capability.company_id = old.company_id
        and capability.approval_request_id = old.id
        and capability.token = capability_token
    ) then
      raise exception 'Approval consumption is server-controlled';
    end if;
    delete from private.storyops_approval_consumption_capabilities capability
    where capability.backend_pid = pg_backend_pid()
      and capability.transaction_id = txid_current()
      and capability.company_id = old.company_id
      and capability.approval_request_id = old.id
      and capability.token = capability_token;
    perform set_config('storyops.approval_consumption_token', '', true);
  end if;
  return new;
end;
$$;

create trigger approval_requests_scope_immutable
  before update on public.approval_requests
  for each row execute function public.protect_approval_request();

revoke all on function public.protect_approval_request()
  from public, anon, authenticated, service_role;

create or replace function public.consume_exact_action_approval(
  p_company_id uuid,
  p_approval_request_id uuid,
  p_reason text,
  p_action_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_exact_payload jsonb,
  p_execution_receipt jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform private.authorize_storyops_approval_consumption(
    p_company_id,
    p_approval_request_id
  );
  update public.approval_requests
  set
    consumed_at = now(),
    execution_receipt = p_execution_receipt
  where id = p_approval_request_id
    and company_id = p_company_id
    and status = 'approved'
    and reason::text = p_reason
    and action_type = p_action_type
    and entity_type = p_entity_type
    and entity_id is not distinct from p_entity_id
    and consumed_at is null
    and (expires_at is null or expires_at > now())
    and coalesce(action_payload -> 'exactPayload', 'null'::jsonb) = p_exact_payload
    and coalesce(action_payload ->> 'payloadHash', '') ~ '^[a-f0-9]{64}$';
  if not found then
    raise exception 'Missing, expired, consumed, or payload-mismatched approval';
  end if;
end;
$$;

revoke all on function public.consume_exact_action_approval(
  uuid, uuid, text, text, text, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role;

-- Technicians can update field state but not assignment, schedule, or foreign keys.
create or replace function public.enforce_technician_visit_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.has_company_role(old.company_id, array['technician']::public.app_role[]) then
    if new.company_id <> old.company_id
      or new.job_id <> old.job_id
      or new.sequence <> old.sequence
      or new.starts_at <> old.starts_at
      or new.ends_at <> old.ends_at
      or new.crew_id <> old.crew_id
      or new.route_check_id is distinct from old.route_check_id
      or new.weather_check_id is distinct from old.weather_check_id
      or new.checklist_template_id <> old.checklist_template_id then
      raise exception 'Technicians cannot change visit assignment, schedule, or policy checks';
    end if;
  end if;
  return new;
end;
$$;

create trigger visits_technician_update_scope
  before update on public.visits
  for each row execute function public.enforce_technician_visit_update();

-- Portal users can edit contact/read-state fields, but never financial or ownership fields.
create or replace function public.enforce_portal_update_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_data jsonb := to_jsonb(old);
  new_data jsonb := to_jsonb(new);
begin
  if tg_table_name = 'customers'
    and public.is_customer_user(old.company_id, old.id)
    and not public.has_company_role(old.company_id, array['owner', 'dispatcher']::public.app_role[])
  then
    if (new_data - array[
      'display_name', 'given_name', 'family_name', 'email', 'phone', 'billing_address',
      'updated_at', 'version'
    ]) <> (old_data - array[
      'display_name', 'given_name', 'family_name', 'email', 'phone', 'billing_address',
      'updated_at', 'version'
    ]) then
      raise exception 'Portal users may update contact fields only';
    end if;
  elsif tg_table_name = 'quotes'
    and public.is_customer_user(old.company_id, old.customer_id)
    and not public.has_company_role(old.company_id, array['owner', 'dispatcher']::public.app_role[])
  then
    if (new_data - array[
      'status', 'accepted_at', 'accepted_by_name', 'accepted_by_user_id',
      'acceptance_ip_hash', 'acceptance_context_hash', 'updated_at', 'version'
    ]) <> (old_data - array[
      'status', 'accepted_at', 'accepted_by_name', 'accepted_by_user_id',
      'acceptance_ip_hash', 'acceptance_context_hash', 'updated_at', 'version'
    ]) then
      raise exception 'Portal users may only view, accept, or decline quotes';
    end if;
  elsif tg_table_name = 'notifications' then
    if (new_data - array['read_at', 'updated_at', 'version'])
      <> (old_data - array['read_at', 'updated_at', 'version']) then
      raise exception 'Notification recipients may update read state only';
    end if;
  end if;
  return new;
end;
$$;

create trigger customers_portal_update_scope
  before update on public.customers
  for each row execute function public.enforce_portal_update_scope();
create trigger quotes_portal_update_scope
  before update on public.quotes
  for each row execute function public.enforce_portal_update_scope();
create trigger notifications_recipient_update_scope
  before update on public.notifications
  for each row execute function public.enforce_portal_update_scope();

-- Field users may record evidence for their own assignment, but may not
-- impersonate another user or rewrite assignment/evidence identity.
create or replace function public.enforce_technician_field_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  company_id_value uuid := coalesce(
    (to_jsonb(new) ->> 'company_id')::uuid,
    (to_jsonb(old) ->> 'company_id')::uuid
  );
  old_data jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  new_data jsonb := to_jsonb(new);
begin
  if not public.has_company_role(
    company_id_value,
    array['technician']::public.app_role[]
  ) or public.has_company_role(
    company_id_value,
    array['owner', 'dispatcher']::public.app_role[]
  ) then
    return new;
  end if;

  if tg_table_name = 'visit_checklist_items' then
    if new.completed_by is not null and new.completed_by <> auth.uid() then
      raise exception 'Technicians may only attest to their own checklist work';
    end if;
    if tg_op = 'UPDATE' and (
      new.company_id <> old.company_id
      or new.visit_id <> old.visit_id
      or new.template_item_id <> old.template_item_id
      or new.offline_client_id is distinct from old.offline_client_id
    ) then
      raise exception 'Checklist identity and assignment are immutable in field mode';
    end if;
  elsif tg_table_name = 'time_entries' then
    if new.user_id <> auth.uid() or new.source <> 'field_app' or new.approved_by is not null then
      raise exception 'Technicians may only record their own unadjusted field time';
    end if;
    if tg_op = 'UPDATE' and (
      new.company_id <> old.company_id
      or new.visit_id <> old.visit_id
      or new.user_id <> old.user_id
      or new.started_at <> old.started_at
      or new.source <> old.source
      or new.offline_client_id is distinct from old.offline_client_id
    ) then
      raise exception 'Time-entry identity and start facts are immutable in field mode';
    end if;
  elsif tg_table_name = 'material_usage' then
    if new.recorded_by <> auth.uid() then
      raise exception 'Technicians may only record their own material usage';
    end if;
    if tg_op = 'UPDATE' and new_data <> old_data then
      raise exception 'Material usage corrections must be appended by back office';
    end if;
  elsif tg_table_name = 'media_assets' then
    if new.captured_by is distinct from auth.uid() then
      raise exception 'Technicians may only attribute uploads to themselves';
    end if;
    if tg_op = 'UPDATE' and (
      new_data - array['sync_state', 'updated_at', 'version']
      <> old_data - array['sync_state', 'updated_at', 'version']
    ) then
      raise exception 'Technicians may update media synchronization state only';
    end if;
  end if;
  return new;
end;
$$;

create trigger visit_checklist_items_technician_scope
  before insert or update on public.visit_checklist_items
  for each row execute function public.enforce_technician_field_mutation();
create trigger time_entries_technician_scope
  before insert or update on public.time_entries
  for each row execute function public.enforce_technician_field_mutation();
create trigger material_usage_technician_scope
  before insert or update on public.material_usage
  for each row execute function public.enforce_technician_field_mutation();
create trigger media_assets_technician_scope
  before insert or update on public.media_assets
  for each row execute function public.enforce_technician_field_mutation();

-- Append-only governance records.
create or replace function public.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE'
    and current_user = 'postgres'
    and current_setting('storyops.retention_purge', true) = 'on'
  then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name;
end;
$$;

create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function public.reject_append_only_mutation();
create trigger ai_traces_append_only
  before update or delete on public.ai_traces
  for each row execute function public.reject_append_only_mutation();
create trigger completion_signatures_append_only
  before update or delete on public.completion_signatures
  for each row execute function public.reject_append_only_mutation();

create or replace function public.redact_audit_payload(
  source_table text,
  source_data jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public, extensions
as $$
declare
  redacted jsonb := source_data;
  sensitive_fields text[] := case source_table
    when 'customers' then array[
      'email', 'phone', 'billing_address', 'notes', 'tax_exemption_reference'
    ]
    when 'properties' then array[
      'service_address', 'access_instructions', 'gate_code_ciphertext',
      'water_source_notes', 'drainage_notes'
    ]
    when 'consent_records' then array['proof']
    when 'communication_messages' then array['sender', 'recipients', 'body']
    when 'integration_connections' then array[
      'configuration', 'secret_reference', 'last_error'
    ]
    when 'approval_requests' then array['action_payload']
    when 'incidents' then array['summary', 'immediate_actions']
    else array[]::text[]
  end;
  field_name text;
  removed_fields text[] := array[]::text[];
begin
  if source_data is null then
    return null;
  end if;
  foreach field_name in array sensitive_fields
  loop
    if redacted ? field_name then
      redacted := redacted - field_name;
      removed_fields := array_append(removed_fields, field_name);
    end if;
  end loop;
  if cardinality(removed_fields) > 0 then
    redacted := redacted || jsonb_build_object(
      '_redacted_fields',
      to_jsonb(removed_fields),
      '_source_sha256',
      encode(extensions.digest(source_data::text, 'sha256'), 'hex')
    );
  end if;
  return redacted;
end;
$$;

create or replace function public.audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  record_company_id uuid;
  record_id uuid;
  actor text;
  actor_kind text;
  request_headers jsonb;
begin
  record_company_id := coalesce(
    (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end ->> 'company_id')::uuid,
    null
  );
  record_id := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end ->> 'id')::uuid;
  actor := coalesce(
    auth.uid()::text,
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    'system'
  );
  actor_kind := case
    when auth.uid() is null then 'system'
    when public.has_company_role(
      record_company_id,
      array['customer']::public.app_role[]
    ) and not public.has_company_role(
      record_company_id,
      array['owner', 'dispatcher', 'technician']::public.app_role[]
    ) then 'customer'
    else 'user'
  end;
  request_headers := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb,
    '{}'::jsonb
  );
  if record_company_id is not null then
    insert into public.audit_events(
      company_id, actor_type, actor_id, action, entity_type, entity_id,
      before_data, after_data, request_id, trace_id, retain_until
    )
    values (
      record_company_id,
      actor_kind,
      actor,
      lower(tg_op),
      tg_table_name,
      record_id,
      case when tg_op in ('UPDATE', 'DELETE')
        then public.redact_audit_payload(tg_table_name, to_jsonb(old))
        else null
      end,
      case when tg_op in ('INSERT', 'UPDATE')
        then public.redact_audit_payload(tg_table_name, to_jsonb(new))
        else null
      end,
      request_headers ->> 'x-request-id',
      request_headers ->> 'x-trace-id',
      now() + interval '7 years'
    );
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'company_memberships', 'leads', 'customers', 'customer_portal_users', 'properties',
    'consent_records', 'service_catalog', 'checklist_templates',
    'checklist_template_items', 'price_books', 'price_book_service_rules',
    'price_book_attribute_multipliers', 'price_book_add_ons',
    'price_book_travel_zones', 'property_measurements', 'photo_analyses',
    'estimates', 'estimate_lines', 'quotes', 'crews', 'crew_members', 'equipment',
    'sds_documents', 'materials', 'jobs', 'route_checks', 'weather_checks', 'visits',
    'dispatch_assignments', 'visit_checklist_items', 'time_entries',
    'material_usage', 'media_assets', 'completion_signatures', 'incidents',
    'invoices', 'invoice_lines', 'payments', 'communication_threads',
    'communication_messages', 'campaigns', 'campaign_recipients', 'reviews',
    'referrals', 'recurring_maintenance_plans', 'approval_requests',
    'automation_runs', 'owner_briefings', 'notifications',
    'integration_connections', 'retention_policies', 'retention_runs'
  ]
  loop
    execute format(
      'create trigger %I_audit after insert or update or delete on public.%I for each row execute function public.audit_mutation()',
      table_name,
      table_name
    );
  end loop;
end;
$$;

-- Webhook and idempotency claims are atomic and only callable by trusted Edge/server code.
create or replace function public.claim_webhook_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_payload_hash text,
  p_payload jsonb,
  p_company_id uuid default null
)
returns table(event_id uuid, claimed boolean, existing_status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  found_row public.webhook_events%rowtype;
begin
  if p_company_id is null
    or not exists (select 1 from public.companies where id = p_company_id)
  then
    raise exception 'A verified webhook must resolve to a known company';
  end if;
  if p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'payload hash must be lowercase SHA-256';
  end if;
  insert into public.webhook_events(
    company_id, provider, provider_event_id, event_type, payload_hash, payload
  )
  values (p_company_id, p_provider, p_provider_event_id, p_event_type, p_payload_hash, p_payload)
  on conflict (provider, provider_event_id) do nothing
  returning id into inserted_id;

  if inserted_id is not null then
    return query select inserted_id, true, 'received'::text;
    return;
  end if;
  select * into found_row from public.webhook_events
  where provider = p_provider and provider_event_id = p_provider_event_id;
  if found_row.payload_hash <> p_payload_hash then
    raise exception 'provider event id reused with a different payload';
  end if;
  if p_company_id is not null
    and found_row.company_id is not null
    and found_row.company_id <> p_company_id
  then
    raise exception 'provider event id reused across companies';
  end if;
  return query select found_row.id, false, found_row.status;
end;
$$;

create or replace function public.start_webhook_processing(
  p_event_id uuid,
  p_payload_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.webhook_events
  set
    status = 'processing',
    attempt_count = attempt_count + 1,
    last_error = null
  where id = p_event_id
    and payload_hash = p_payload_hash
    and status in ('received', 'failed')
    and attempt_count < 50
    and payload_purged_at is null;
  return found;
end;
$$;

create or replace function public.complete_webhook_event(
  p_event_id uuid,
  p_payload_hash text,
  p_disposition text default 'processed'
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_disposition not in ('processed', 'ignored') then
    raise exception 'Webhook disposition must be processed or ignored';
  end if;
  update public.webhook_events
  set status = p_disposition, processed_at = now(), last_error = null
  where id = p_event_id
    and payload_hash = p_payload_hash
    and status = 'processing';
  if not found then
    raise exception 'No matching webhook processing lease';
  end if;
end;
$$;

create or replace function public.fail_webhook_event(
  p_event_id uuid,
  p_payload_hash text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.webhook_events
  set
    status = 'failed',
    processed_at = null,
    last_error = left(nullif(btrim(p_error), ''), 2000)
  where id = p_event_id
    and payload_hash = p_payload_hash
    and status = 'processing';
  if not found then
    raise exception 'No matching webhook processing lease';
  end if;
end;
$$;

create or replace function public.claim_idempotency_key(
  p_company_id uuid,
  p_scope text,
  p_key text,
  p_request_hash text,
  p_expires_at timestamptz
)
returns table(claim_status text, stored_response jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_id uuid;
  found_row public.idempotency_keys%rowtype;
begin
  if p_expires_at <= now() then
    raise exception 'idempotency expiry must be in the future';
  end if;
  insert into public.idempotency_keys(company_id, scope, key, request_hash, expires_at)
  values (p_company_id, p_scope, p_key, p_request_hash, p_expires_at)
  on conflict (company_id, scope, key) do nothing
  returning id into inserted_id;

  if inserted_id is not null then
    return query select 'reserved'::text, null::jsonb;
    return;
  end if;
  select * into found_row from public.idempotency_keys
  where company_id = p_company_id and scope = p_scope and key = p_key
  for update;
  if found_row.expires_at <= now() then
    update public.idempotency_keys
    set
      request_hash = p_request_hash,
      status = 'in_progress',
      response = null,
      error_code = null,
      locked_at = now(),
      completed_at = null,
      expires_at = p_expires_at
    where id = found_row.id;
    return query select 'reserved'::text, null::jsonb;
  elsif found_row.request_hash <> p_request_hash then
    return query select 'conflict'::text, null::jsonb;
  elsif found_row.status = 'completed' then
    return query select 'completed'::text, found_row.response;
  elsif found_row.status = 'failed' then
    update public.idempotency_keys
    set
      status = 'in_progress',
      response = null,
      error_code = null,
      locked_at = now(),
      completed_at = null,
      expires_at = p_expires_at
    where id = found_row.id;
    return query select 'reserved'::text, null::jsonb;
  else
    return query select 'in_progress'::text, null::jsonb;
  end if;
end;
$$;

create or replace function public.complete_idempotency_key(
  p_company_id uuid,
  p_scope text,
  p_key text,
  p_request_hash text,
  p_response jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.idempotency_keys
  set status = 'completed', response = p_response, completed_at = now()
  where company_id = p_company_id
    and scope = p_scope
    and key = p_key
    and request_hash = p_request_hash
    and status = 'in_progress';
  if not found then
    raise exception 'No matching in-progress idempotency reservation';
  end if;
end;
$$;

create or replace function public.fail_idempotency_key(
  p_company_id uuid,
  p_scope text,
  p_key text,
  p_request_hash text,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.idempotency_keys
  set
    status = 'failed',
    error_code = left(nullif(btrim(p_error_code), ''), 255),
    completed_at = now()
  where company_id = p_company_id
    and scope = p_scope
    and key = p_key
    and request_hash = p_request_hash
    and status = 'in_progress';
  if not found then
    raise exception 'No matching in-progress idempotency reservation';
  end if;
end;
$$;

revoke all on function public.claim_webhook_event(text, text, text, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.start_webhook_processing(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_webhook_event(uuid, text, text) from public, anon, authenticated;
revoke all on function public.fail_webhook_event(uuid, text, text) from public, anon, authenticated;
revoke all on function public.claim_idempotency_key(uuid, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_idempotency_key(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.fail_idempotency_key(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.claim_webhook_event(text, text, text, text, jsonb, uuid) to service_role;
grant execute on function public.start_webhook_processing(uuid, text) to service_role;
grant execute on function public.complete_webhook_event(uuid, text, text) to service_role;
grant execute on function public.fail_webhook_event(uuid, text, text) to service_role;
grant execute on function public.claim_idempotency_key(uuid, text, text, text, timestamptz) to service_role;
grant execute on function public.complete_idempotency_key(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.fail_idempotency_key(uuid, text, text, text, text) to service_role;

create or replace function public.apply_retention_policy(
  p_company_id uuid,
  p_cutoff_at timestamptz,
  p_dry_run boolean default true,
  p_approval_request_id uuid default null
)
returns table(
  run_id uuid,
  candidate_counts jsonb,
  affected_counts jsonb,
  evidence_sha256 text
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  policy_row public.retention_policies%rowtype;
  approval_row public.approval_requests%rowtype;
  generated_run_id uuid := gen_random_uuid();
  candidates jsonb;
  affected jsonb := '{}'::jsonb;
  evidence_hash text;
  affected_rows bigint;
begin
  if p_cutoff_at > now() then
    raise exception 'Retention cutoff cannot be in the future';
  end if;
  select *
  into policy_row
  from public.retention_policies
  where company_id = p_company_id
    and status in ('active', 'draft')
    and effective_from <= p_cutoff_at
  order by (status = 'active') desc, effective_from desc
  limit 1;
  if not found then
    raise exception 'No retention policy exists for the requested cutoff';
  end if;
  if not p_dry_run and policy_row.status <> 'active' then
    raise exception 'Retention deletion requires a legally reviewed active policy';
  end if;

  candidates := jsonb_build_object(
    'aiTraces', (
      select count(*) from public.ai_traces
      where company_id = p_company_id
        and retain_until <= p_cutoff_at
        and not legal_hold
    ),
    'auditEvents', (
      select count(*) from public.audit_events
      where company_id = p_company_id
        and retain_until <= p_cutoff_at
        and not legal_hold
    ),
    'communications', (
      select count(*) from public.communication_messages
      where company_id = p_company_id
        and retain_until <= p_cutoff_at
        and not legal_hold
    ),
    'photoAnalyses', (
      select count(*) from public.photo_analyses
      where company_id = p_company_id
        and retain_until <= p_cutoff_at
        and not legal_hold
    ),
    'webhookPayloads', (
      select count(*) from public.webhook_events
      where company_id = p_company_id
        and raw_payload_retain_until <= p_cutoff_at
        and payload_purged_at is null
        and not legal_hold
    ),
    'webhookReceipts', (
      select count(*) from public.webhook_events
      where company_id = p_company_id
        and receipt_retain_until <= p_cutoff_at
        and not legal_hold
    ),
    'idempotencyKeys', (
      select count(*) from public.idempotency_keys
      where company_id = p_company_id and expires_at <= p_cutoff_at
    )
  );
  affected := case when p_dry_run then '{}'::jsonb else candidates end;
  evidence_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'companyId', p_company_id,
        'cutoffAt', p_cutoff_at,
        'policyId', policy_row.id,
        'dryRun', p_dry_run,
        'candidates', candidates
      )::text,
      'sha256'
    ),
    'hex'
  );

  if p_dry_run then
    if p_approval_request_id is not null then
      raise exception 'Dry-run retention reports must not consume an approval';
    end if;
    insert into public.retention_runs(
      id, company_id, retention_policy_id, cutoff_at, dry_run, status,
      candidate_counts, affected_counts, evidence_sha256, executed_by
    )
    values (
      generated_run_id, p_company_id, policy_row.id, p_cutoff_at, true, 'planned',
      candidates, '{}'::jsonb, evidence_hash,
      coalesce(auth.uid()::text, current_user)
    );
    return query select generated_run_id, candidates, '{}'::jsonb, evidence_hash;
    return;
  end if;

  if p_approval_request_id is null then
    raise exception 'An approved destructive-change request is required';
  end if;
  select *
  into approval_row
  from public.approval_requests
  where id = p_approval_request_id
    and company_id = p_company_id
  for update;
  if not found
    or approval_row.status <> 'approved'
    or approval_row.reason <> 'destructive_change'
    or approval_row.action_type <> 'retention.purge'
    or approval_row.entity_type <> 'company'
    or approval_row.entity_id is distinct from p_company_id
    or approval_row.consumed_at is not null
    or (
      approval_row.expires_at is not null
      and approval_row.expires_at <= now()
    )
    or not coalesce(
      approval_row.action_payload ->> 'payloadHash' ~ '^[a-f0-9]{64}$',
      false
    )
    or approval_row.action_payload -> 'exactPayload' ->> 'operation'
      is distinct from 'retention.purge'
    or approval_row.action_payload -> 'exactPayload' ->> 'companyId'
      is distinct from p_company_id::text
    or (
      approval_row.action_payload -> 'exactPayload' ->> 'cutoffAt'
    )::timestamptz is distinct from p_cutoff_at
  then
    raise exception 'Approval does not authorize this exact retention purge';
  end if;

  perform private.authorize_storyops_approval_consumption(
    p_company_id,
    approval_row.id
  );
  update public.approval_requests
  set
    consumed_at = now(),
    execution_receipt = jsonb_build_object(
      'runId', generated_run_id,
      'status', 'running',
      'candidateEvidenceSha256', evidence_hash
    )
  where id = approval_row.id and consumed_at is null;
  if not found then
    raise exception 'Retention approval was already consumed';
  end if;

  perform set_config('storyops.retention_purge', 'on', true);

  delete from public.communication_messages
  where company_id = p_company_id
    and retain_until <= p_cutoff_at
    and not legal_hold;
  get diagnostics affected_rows = row_count;
  affected := affected || jsonb_build_object('communications', affected_rows);

  delete from public.photo_analyses
  where company_id = p_company_id
    and retain_until <= p_cutoff_at
    and not legal_hold;
  get diagnostics affected_rows = row_count;
  affected := affected || jsonb_build_object('photoAnalyses', affected_rows);

  delete from public.ai_traces
  where company_id = p_company_id
    and retain_until <= p_cutoff_at
    and not legal_hold;
  get diagnostics affected_rows = row_count;
  affected := affected || jsonb_build_object('aiTraces', affected_rows);

  delete from public.audit_events
  where company_id = p_company_id
    and retain_until <= p_cutoff_at
    and not legal_hold;
  get diagnostics affected_rows = row_count;
  affected := affected || jsonb_build_object('auditEvents', affected_rows);

  update public.webhook_events
  set payload = '{}'::jsonb, payload_purged_at = now()
  where company_id = p_company_id
    and raw_payload_retain_until <= p_cutoff_at
    and payload_purged_at is null
    and not legal_hold;
  get diagnostics affected_rows = row_count;
  affected := affected || jsonb_build_object('webhookPayloads', affected_rows);

  delete from public.webhook_events
  where company_id = p_company_id
    and receipt_retain_until <= p_cutoff_at
    and not legal_hold;
  get diagnostics affected_rows = row_count;
  affected := affected || jsonb_build_object('webhookReceipts', affected_rows);

  delete from public.idempotency_keys
  where company_id = p_company_id and expires_at <= p_cutoff_at;
  get diagnostics affected_rows = row_count;
  affected := affected || jsonb_build_object('idempotencyKeys', affected_rows);

  evidence_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'companyId', p_company_id,
        'cutoffAt', p_cutoff_at,
        'policyId', policy_row.id,
        'approvalId', approval_row.id,
        'candidates', candidates,
        'affected', affected
      )::text,
      'sha256'
    ),
    'hex'
  );

  insert into public.retention_runs(
    id, company_id, retention_policy_id, approval_request_id, cutoff_at,
    dry_run, status, candidate_counts, affected_counts, evidence_sha256,
    executed_by
  )
  values (
    generated_run_id, p_company_id, policy_row.id, approval_row.id, p_cutoff_at,
    false, 'succeeded', candidates, affected, evidence_hash,
    coalesce(auth.uid()::text, current_user)
  );
  perform private.authorize_storyops_approval_consumption(
    p_company_id,
    approval_row.id
  );
  update public.approval_requests
  set execution_receipt = jsonb_build_object(
    'runId', generated_run_id,
    'status', 'succeeded',
    'evidenceSha256', evidence_hash,
    'affected', affected
  )
  where id = approval_row.id;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, retain_until
  )
  values (
    p_company_id,
    case when auth.uid() is null then 'system' else 'user' end,
    coalesce(auth.uid()::text, current_user),
    'retention.purge',
    'retention_run',
    generated_run_id,
    jsonb_build_object(
      'policyId', policy_row.id,
      'approvalId', approval_row.id,
      'cutoffAt', p_cutoff_at,
      'affected', affected,
      'evidenceSha256', evidence_hash
    ),
    now() + interval '7 years'
  );

  return query select generated_run_id, candidates, affected, evidence_hash;
end;
$$;

revoke all on function public.apply_retention_policy(uuid, timestamptz, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.apply_retention_policy(uuid, timestamptz, boolean, uuid)
  to service_role;

-- Authenticated live read model. Every projection is role-specific so the
-- shared PostgREST `authenticated` role never receives internal columns merely
-- because row-level access exists.
create or replace function public.get_storyops_workspace(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  result jsonb;
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
  if actor_role is null then
    raise exception 'No active company membership';
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-workspace-v1',
    'serverTime', now(),
    'session', jsonb_build_object(
      'userId', actor_user_id,
      'companyId', p_company_id,
      'role', actor_role
    ),
    'company', (
      select jsonb_build_object(
        'id', company.id,
        'name', company.name,
        'timezone', company.timezone,
        'currency', company.currency,
        'status', company.status,
        'settings', case
          when actor_role in ('owner', 'dispatcher') then company.settings
          else '{}'::jsonb
        end,
        'version', 1
      )
      from public.companies company
      where company.id = p_company_id
    )
  );

  if actor_role in ('owner', 'dispatcher') then
    return result || jsonb_build_object(
      'leads', coalesce((
        select jsonb_agg(to_jsonb(lead) order by lead.updated_at desc)
        from public.leads lead where lead.company_id = p_company_id
      ), '[]'::jsonb),
      'customers', coalesce((
        select jsonb_agg(to_jsonb(customer) order by customer.updated_at desc)
        from public.customers customer where customer.company_id = p_company_id
      ), '[]'::jsonb),
      'properties', coalesce((
        select jsonb_agg(
          to_jsonb(property) - 'gate_code_ciphertext'
          || jsonb_build_object(
            'hasGateCode', property.gate_code_ciphertext is not null
          )
          order by property.updated_at desc
        )
        from public.properties property where property.company_id = p_company_id
      ), '[]'::jsonb),
      'estimates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', estimate.id,
          'estimateNumber', estimate.estimate_number,
          'customerId', estimate.customer_id,
          'propertyId', estimate.property_id,
          'priceBookId', estimate.price_book_id,
          'priceBookVersion', estimate.price_book_version,
          'status', estimate.status,
          'serviceSubtotal', estimate.service_subtotal::text,
          'minimumAdjustment', estimate.minimum_adjustment::text,
          'travelFee', estimate.travel_fee::text,
          'manualAdjustment', estimate.manual_adjustment::text,
          'discount', estimate.discount::text,
          'tax', estimate.tax::text,
          'total', estimate.total::text,
          'depositRequired', estimate.deposit_required::text,
          'estimatedCost', estimate.estimated_cost::text,
          'estimatedMarginPct', estimate.estimated_margin_pct::text,
          'durationMinutes', estimate.duration_minutes,
          'calculationVersion', estimate.calculation_version,
          'calculationIssues', estimate.calculation_issues,
          'calculatedAt', estimate.calculated_at,
          'version', estimate.version
        ) order by estimate.updated_at desc)
        from public.estimates estimate where estimate.company_id = p_company_id
      ), '[]'::jsonb),
      'quotes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', quote.id,
          'quoteNumber', quote.quote_number,
          'estimateId', quote.estimate_id,
          'customerId', quote.customer_id,
          'propertyId', quote.property_id,
          'status', quote.status,
          'validUntil', quote.valid_until,
          'termsVersion', quote.terms_version,
          'termsSnapshot', quote.terms_snapshot,
          'total', quote.total::text,
          'depositRequired', quote.deposit_required::text,
          'sentAt', quote.sent_at,
          'acceptedAt', quote.accepted_at,
          'acceptedByName', quote.accepted_by_name,
          'version', quote.version
        ) order by quote.updated_at desc)
        from public.quotes quote where quote.company_id = p_company_id
      ), '[]'::jsonb),
      'jobs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', job.id,
          'jobNumber', job.job_number,
          'quoteId', job.quote_id,
          'customerId', job.customer_id,
          'propertyId', job.property_id,
          'status', job.status,
          'priority', job.priority,
          'serviceCodes', job.service_codes,
          'estimatedDurationMinutes', job.estimated_duration_minutes,
          'estimatedRevenue', job.estimated_revenue::text,
          'estimatedCost', job.estimated_cost::text,
          'assignedCrewId', job.assigned_crew_id,
          'version', job.version
        ) order by job.updated_at desc)
        from public.jobs job where job.company_id = p_company_id
      ), '[]'::jsonb),
      'visits', coalesce((
        select jsonb_agg(to_jsonb(visit) order by visit.starts_at)
        from public.visits visit where visit.company_id = p_company_id
      ), '[]'::jsonb),
      'checklistItems', coalesce((
        select jsonb_agg(to_jsonb(item) order by item.created_at)
        from public.visit_checklist_items item where item.company_id = p_company_id
      ), '[]'::jsonb),
      'timeEntries', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', entry.id,
          'visitId', entry.visit_id,
          'userId', entry.user_id,
          'startedAt', entry.started_at,
          'endedAt', entry.ended_at,
          'breakMinutes', entry.break_minutes,
          'source', entry.source,
          'approvedBy', entry.approved_by,
          'offlineClientId', entry.offline_client_id,
          'version', entry.version
        ) order by entry.started_at)
        from public.time_entries entry where entry.company_id = p_company_id
      ), '[]'::jsonb),
      'materialUsage', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', usage.id,
          'visitId', usage.visit_id,
          'materialId', usage.material_id,
          'quantity', usage.quantity::text,
          'unit', usage.unit,
          'recordedAt', usage.recorded_at,
          'recordedBy', usage.recorded_by,
          'offlineClientId', usage.offline_client_id
        ) order by usage.recorded_at)
        from public.material_usage usage where usage.company_id = p_company_id
      ), '[]'::jsonb),
      'media', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', media.id,
          'propertyId', media.property_id,
          'jobId', media.job_id,
          'visitId', media.visit_id,
          'incidentId', media.incident_id,
          'purpose', media.purpose,
          'objectPath', media.object_path,
          'contentType', media.content_type,
          'byteSize', media.byte_size,
          'checksumSha256', media.checksum_sha256,
          'capturedAt', media.captured_at,
          'capturedBy', media.captured_by,
          'customerVisible', media.customer_visible,
          'offlineClientId', media.offline_client_id,
          'syncState', media.sync_state,
          'version', media.version
        ) order by media.captured_at)
        from public.media_assets media where media.company_id = p_company_id
      ), '[]'::jsonb),
      'completionSignatures', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', signature.id,
          'visitId', signature.visit_id,
          'signerName', signature.signer_name,
          'signerRole', signature.signer_role,
          'signedAt', signature.signed_at,
          'signatureAssetId', signature.signature_asset_id,
          'disclosureVersion', signature.disclosure_version
        ) order by signature.signed_at)
        from public.completion_signatures signature
        where signature.company_id = p_company_id
      ), '[]'::jsonb),
      'materials', coalesce((
        select jsonb_agg(to_jsonb(material) order by material.name)
        from public.materials material where material.company_id = p_company_id
      ), '[]'::jsonb),
      'equipment', coalesce((
        select jsonb_agg(to_jsonb(asset) order by asset.name)
        from public.equipment asset where asset.company_id = p_company_id
      ), '[]'::jsonb),
      'incidents', coalesce((
        select jsonb_agg(to_jsonb(incident) order by incident.reported_at desc)
        from public.incidents incident where incident.company_id = p_company_id
      ), '[]'::jsonb),
      'invoices', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', invoice.id,
          'invoiceNumber', invoice.invoice_number,
          'customerId', invoice.customer_id,
          'jobId', invoice.job_id,
          'status', invoice.status,
          'issueDate', invoice.issue_date,
          'dueDate', invoice.due_date,
          'subtotal', invoice.subtotal::text,
          'tax', invoice.tax::text,
          'total', invoice.total::text,
          'amountPaid', invoice.amount_paid::text,
          'balanceDue', invoice.balance_due::text,
          'version', invoice.version
        ) order by invoice.issue_date desc)
        from public.invoices invoice where invoice.company_id = p_company_id
      ), '[]'::jsonb),
      'payments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', payment.id,
          'invoiceId', payment.invoice_id,
          'customerId', payment.customer_id,
          'provider', payment.provider,
          'paymentType', payment.payment_type,
          'status', payment.status,
          'amount', payment.amount::text,
          'processedAt', payment.processed_at,
          'version', payment.version
        ) order by payment.created_at desc)
        from public.payments payment where payment.company_id = p_company_id
      ), '[]'::jsonb),
      'approvals', coalesce((
        select jsonb_agg(
          to_jsonb(approval) - 'action_payload'
          || jsonb_build_object(
            'payloadHash', approval.action_payload ->> 'payloadHash',
            'exactPayload', approval.action_payload -> 'exactPayload'
          )
          order by approval.requested_at desc
        )
        from public.approval_requests approval where approval.company_id = p_company_id
      ), '[]'::jsonb),
      'notifications', coalesce((
        select jsonb_agg(to_jsonb(notification) order by notification.created_at desc)
        from public.notifications notification
        where notification.company_id = p_company_id
          and notification.recipient_user_id = actor_user_id
      ), '[]'::jsonb),
      'integrationHealth', coalesce((
        select jsonb_agg(jsonb_build_object(
          'provider', connection.provider,
          'mode', connection.mode,
          'status', connection.status,
          'capabilities', connection.capabilities,
          'lastCheckedAt', connection.last_checked_at,
          'lastError', connection.last_error,
          'configured', connection.secret_reference is not null or connection.mode = 'sandbox',
          'version', connection.version
        ) order by connection.provider)
        from public.integration_connections connection
        where connection.company_id = p_company_id
      ), '[]'::jsonb)
    );
  elsif actor_role = 'technician' then
    return result || jsonb_build_object(
      'jobs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', job.id,
          'jobNumber', job.job_number,
          'customerId', job.customer_id,
          'propertyId', job.property_id,
          'status', job.status,
          'priority', job.priority,
          'serviceCodes', job.service_codes,
          'estimatedDurationMinutes', job.estimated_duration_minutes,
          'assignedCrewId', job.assigned_crew_id,
          'version', job.version
        ) order by job.updated_at desc)
        from public.jobs job
        where job.company_id = p_company_id
          and public.is_assigned_technician_for_job(job.id)
      ), '[]'::jsonb),
      'visits', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', visit.id,
          'jobId', visit.job_id,
          'sequence', visit.sequence,
          'status', visit.status,
          'startsAt', visit.starts_at,
          'endsAt', visit.ends_at,
          'crewId', visit.crew_id,
          'checklistTemplateId', visit.checklist_template_id,
          'internalNotes', visit.internal_notes,
          'customerNotes', visit.customer_notes,
          'offlineRevision', visit.offline_revision,
          'lastSyncedAt', visit.last_synced_at,
          'version', visit.version
        ) order by visit.starts_at)
        from public.visits visit
        where visit.company_id = p_company_id
          and public.is_assigned_technician_for_visit(visit.id)
      ), '[]'::jsonb),
      'customers', coalesce((
        select jsonb_agg(distinct jsonb_build_object(
          'id', customer.id,
          'displayName', customer.display_name,
          'phone', customer.phone
        ))
        from public.customers customer
        join public.jobs job on job.customer_id = customer.id
        where customer.company_id = p_company_id
          and public.is_assigned_technician_for_job(job.id)
      ), '[]'::jsonb),
      'properties', coalesce((
        select jsonb_agg(distinct jsonb_build_object(
          'id', property.id,
          'customerId', property.customer_id,
          'name', property.name,
          'serviceAddress', property.service_address,
          'accessInstructions', property.access_instructions,
          'waterSourceNotes', property.water_source_notes,
          'drainageNotes', property.drainage_notes,
          'knownHazards', property.known_hazards,
          'stories', property.stories,
          'latitude', property.latitude,
          'longitude', property.longitude,
          'version', property.version
        ))
        from public.properties property
        join public.jobs job on job.property_id = property.id
        where property.company_id = p_company_id
          and public.is_assigned_technician_for_job(job.id)
      ), '[]'::jsonb),
      'checklistItems', coalesce((
        select jsonb_agg(to_jsonb(item) order by item.created_at)
        from public.visit_checklist_items item
        where item.company_id = p_company_id
          and public.is_assigned_technician_for_visit(item.visit_id)
      ), '[]'::jsonb),
      'timeEntries', coalesce((
        select jsonb_agg(to_jsonb(entry) order by entry.started_at)
        from public.time_entries entry
        where entry.company_id = p_company_id
          and public.is_assigned_technician_for_visit(entry.visit_id)
      ), '[]'::jsonb),
      'materialUsage', coalesce((
        select jsonb_agg(to_jsonb(usage) order by usage.recorded_at)
        from public.material_usage usage
        where usage.company_id = p_company_id
          and public.is_assigned_technician_for_visit(usage.visit_id)
      ), '[]'::jsonb),
      'media', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', media.id,
          'propertyId', media.property_id,
          'jobId', media.job_id,
          'visitId', media.visit_id,
          'purpose', media.purpose,
          'objectPath', media.object_path,
          'contentType', media.content_type,
          'byteSize', media.byte_size,
          'capturedAt', media.captured_at,
          'customerVisible', media.customer_visible,
          'syncState', media.sync_state,
          'version', media.version
        ) order by media.captured_at)
        from public.media_assets media
        where media.company_id = p_company_id
          and media.visit_id is not null
          and public.is_assigned_technician_for_visit(media.visit_id)
      ), '[]'::jsonb),
      'materials', coalesce((
        select jsonb_agg(to_jsonb(material) order by material.name)
        from public.materials material
        where material.company_id = p_company_id and material.active
      ), '[]'::jsonb),
      'equipment', coalesce((
        select jsonb_agg(to_jsonb(asset) order by asset.name)
        from public.equipment asset
        where asset.company_id = p_company_id and asset.status <> 'retired'
      ), '[]'::jsonb)
    );
  else
    return result || jsonb_build_object(
      'customers', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', customer.id,
          'displayName', customer.display_name,
          'givenName', customer.given_name,
          'familyName', customer.family_name,
          'businessName', customer.business_name,
          'email', customer.email,
          'phone', customer.phone,
          'billingAddress', customer.billing_address,
          'version', customer.version
        ))
        from public.customer_portal_users portal
        join public.customers customer on customer.id = portal.customer_id
        where portal.company_id = p_company_id and portal.user_id = actor_user_id
      ), '[]'::jsonb),
      'properties', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', property.id,
          'customerId', property.customer_id,
          'name', property.name,
          'propertyType', property.property_type,
          'serviceAddress', property.service_address,
          'accessInstructions', property.access_instructions,
          'knownHazards', property.known_hazards,
          'stories', property.stories,
          'lastServicedAt', property.last_serviced_at,
          'version', property.version
        ))
        from public.properties property
        join public.customer_portal_users portal
          on portal.customer_id = property.customer_id
          and portal.company_id = property.company_id
        where property.company_id = p_company_id and portal.user_id = actor_user_id
      ), '[]'::jsonb),
      'quotes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', quote.id,
          'quoteNumber', quote.quote_number,
          'propertyId', quote.property_id,
          'status', quote.status,
          'validUntil', quote.valid_until,
          'termsVersion', quote.terms_version,
          'termsSnapshot', quote.terms_snapshot,
          'total', quote.total::text,
          'depositRequired', quote.deposit_required::text,
          'sentAt', quote.sent_at,
          'acceptedAt', quote.accepted_at,
          'acceptedByName', quote.accepted_by_name,
          'version', quote.version
        ) order by quote.created_at desc)
        from public.quotes quote
        where quote.company_id = p_company_id
          and public.is_customer_user(p_company_id, quote.customer_id)
          and quote.status not in ('draft', 'pending_approval', 'void')
      ), '[]'::jsonb),
      'jobs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', job.id,
          'jobNumber', job.job_number,
          'propertyId', job.property_id,
          'status', job.status,
          'serviceCodes', job.service_codes,
          'estimatedDurationMinutes', job.estimated_duration_minutes,
          'version', job.version
        ) order by job.updated_at desc)
        from public.jobs job
        where job.company_id = p_company_id
          and public.is_customer_user(p_company_id, job.customer_id)
      ), '[]'::jsonb),
      'visits', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', visit.id,
          'jobId', visit.job_id,
          'status', visit.status,
          'startsAt', visit.starts_at,
          'endsAt', visit.ends_at,
          'customerNotes', visit.customer_notes,
          'version', visit.version
        ) order by visit.starts_at desc)
        from public.visits visit
        join public.jobs job on job.id = visit.job_id
        where visit.company_id = p_company_id
          and public.is_customer_user(p_company_id, job.customer_id)
      ), '[]'::jsonb),
      'invoices', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', invoice.id,
          'invoiceNumber', invoice.invoice_number,
          'jobId', invoice.job_id,
          'status', invoice.status,
          'issueDate', invoice.issue_date,
          'dueDate', invoice.due_date,
          'subtotal', invoice.subtotal::text,
          'tax', invoice.tax::text,
          'total', invoice.total::text,
          'amountPaid', invoice.amount_paid::text,
          'balanceDue', invoice.balance_due::text,
          'version', invoice.version
        ) order by invoice.issue_date desc)
        from public.invoices invoice
        where invoice.company_id = p_company_id
          and public.is_customer_user(p_company_id, invoice.customer_id)
      ), '[]'::jsonb),
      'payments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', payment.id,
          'invoiceId', payment.invoice_id,
          'paymentType', payment.payment_type,
          'status', payment.status,
          'amount', payment.amount::text,
          'processedAt', payment.processed_at,
          'version', payment.version
        ) order by payment.created_at desc)
        from public.payments payment
        where payment.company_id = p_company_id
          and public.is_customer_user(p_company_id, payment.customer_id)
      ), '[]'::jsonb),
      'media', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', media.id,
          'propertyId', media.property_id,
          'jobId', media.job_id,
          'visitId', media.visit_id,
          'purpose', media.purpose,
          'objectPath', media.object_path,
          'contentType', media.content_type,
          'capturedAt', media.captured_at,
          'version', media.version
        ) order by media.captured_at desc)
        from public.media_assets media
        join public.properties property on property.id = media.property_id
        where media.company_id = p_company_id
          and media.customer_visible
          and public.is_customer_user(p_company_id, property.customer_id)
      ), '[]'::jsonb),
      'recurringPlans', coalesce((
        select jsonb_agg(to_jsonb(plan) order by plan.next_due_date)
        from public.recurring_maintenance_plans plan
        where plan.company_id = p_company_id
          and public.is_customer_user(p_company_id, plan.customer_id)
      ), '[]'::jsonb),
      'notifications', coalesce((
        select jsonb_agg(to_jsonb(notification) order by notification.created_at desc)
        from public.notifications notification
        join public.customer_portal_users portal
          on portal.customer_id = notification.recipient_customer_id
          and portal.company_id = notification.company_id
        where notification.company_id = p_company_id and portal.user_id = actor_user_id
      ), '[]'::jsonb)
    );
  end if;
end;
$$;

revoke all on function public.get_storyops_workspace(uuid) from public, anon;
grant execute on function public.get_storyops_workspace(uuid) to authenticated;

-- Authenticated destructive deletes are never implicit. An owner-approved,
-- unexpired request must match the exact table and row, and is consumed once.
-- Trusted service flows run without an end-user JWT and remain responsible for
-- their own scoped approval/retention contracts.
create or replace function public.require_exact_delete_approval()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  approval_id_value uuid;
  actor_user_id uuid := auth.uid();
  exact_payload jsonb := jsonb_build_object(
    'action', 'delete',
    'entityType', tg_table_name,
    'entityId', old.id
  );
begin
  if actor_user_id is null or pg_trigger_depth() > 1 then
    return old;
  end if;

  select approval.id
  into approval_id_value
  from public.approval_requests approval
  where approval.company_id = old.company_id
    and approval.reason = 'destructive_change'
    and approval.status = 'approved'
    and approval.entity_type = tg_table_name
    and approval.entity_id = old.id
    and approval.action_type = 'delete'
    and approval.action_payload -> 'exactPayload' = exact_payload
    and approval.consumed_at is null
    and (approval.expires_at is null or approval.expires_at > now())
  order by approval.decided_at
  for update skip locked
  limit 1;

  if approval_id_value is null then
    raise exception 'Exact owner approval is required to delete %.%', tg_table_name, old.id;
  end if;

  perform private.authorize_storyops_approval_consumption(
    old.company_id,
    approval_id_value
  );
  update public.approval_requests
  set consumed_at = now(),
      execution_receipt = jsonb_build_object(
        'action', 'delete',
        'entityType', tg_table_name,
        'entityId', old.id,
        'executedBy', actor_user_id,
        'executedAt', now()
      ),
      updated_at = now(),
      version = version + 1
  where id = approval_id_value;

  return old;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'company_memberships', 'leads', 'customers', 'customer_portal_users',
    'properties', 'consent_records', 'service_catalog', 'checklist_templates',
    'checklist_template_items', 'price_books', 'price_book_service_rules',
    'price_book_attribute_multipliers', 'price_book_add_ons',
    'price_book_travel_zones', 'property_measurements', 'photo_analyses',
    'estimates', 'estimate_lines', 'quotes', 'crews', 'crew_members',
    'equipment', 'sds_documents', 'materials', 'jobs', 'route_checks',
    'weather_checks', 'visits', 'dispatch_assignments',
    'visit_checklist_items', 'time_entries', 'material_usage', 'media_assets',
    'completion_signatures', 'incidents', 'invoices', 'invoice_lines',
    'payments', 'communication_threads', 'communication_messages', 'campaigns',
    'campaign_recipients', 'reviews', 'referrals',
    'recurring_maintenance_plans', 'automation_runs', 'owner_briefings',
    'notifications', 'integration_connections', 'search_documents'
  ]
  loop
    execute format(
      'create trigger %I_exact_delete_approval before delete on public.%I for each row execute function public.require_exact_delete_approval()',
      table_name, table_name
    );
  end loop;
end;
$$;

-- RLS is enabled on every tenant or user-facing table.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'companies', 'profiles', 'company_memberships', 'leads', 'customers',
    'customer_portal_users', 'properties', 'consent_records', 'service_catalog',
    'checklist_templates', 'checklist_template_items', 'price_books',
    'price_book_service_rules', 'price_book_attribute_multipliers', 'price_book_add_ons',
    'price_book_travel_zones', 'property_measurements', 'photo_analyses', 'estimates',
    'estimate_lines', 'quotes', 'crews', 'crew_members', 'equipment', 'sds_documents',
    'materials', 'jobs', 'route_checks', 'weather_checks', 'visits',
    'dispatch_assignments', 'visit_checklist_items', 'time_entries', 'material_usage',
    'media_assets', 'completion_signatures', 'incidents', 'invoices', 'invoice_lines',
    'payments', 'communication_threads', 'communication_messages', 'campaigns',
    'campaign_recipients', 'reviews', 'referrals', 'recurring_maintenance_plans',
    'approval_requests', 'automation_runs', 'ai_traces', 'audit_events',
    'owner_briefings', 'notifications', 'integration_connections', 'webhook_events',
    'idempotency_keys', 'retention_policies', 'retention_runs', 'search_documents'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
  end loop;
end;
$$;

create policy companies_select on public.companies for select
  using (public.is_company_member(id));
create policy companies_owner_update on public.companies for update
  using (public.has_company_role(id, array['owner']::public.app_role[]))
  with check (public.has_company_role(id, array['owner']::public.app_role[]));

create policy profiles_self_select on public.profiles for select using (id = auth.uid());
create policy profiles_self_update on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_colleague_select on public.profiles for select using (
  exists (
    select 1 from public.company_memberships mine
    join public.company_memberships theirs on theirs.company_id = mine.company_id
    where mine.user_id = auth.uid()
      and mine.active
      and mine.role in ('owner', 'dispatcher', 'technician')
      and theirs.user_id = profiles.id
      and theirs.active
      and theirs.role in ('owner', 'dispatcher', 'technician')
  )
);

create policy memberships_select on public.company_memberships for select
  using (user_id = auth.uid() or public.has_company_role(company_id, array['owner']::public.app_role[]));
create policy memberships_owner_insert on public.company_memberships for insert
  with check (public.has_company_role(company_id, array['owner']::public.app_role[]));
create policy memberships_owner_update on public.company_memberships for update
  using (public.has_company_role(company_id, array['owner']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner']::public.app_role[]));
create policy memberships_owner_delete on public.company_memberships for delete
  using (public.has_company_role(company_id, array['owner']::public.app_role[]));

create policy customer_portal_users_select on public.customer_portal_users for select
  using (user_id = auth.uid() or public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy customer_portal_users_manage on public.customer_portal_users for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));

-- Back-office managed tables.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'leads', 'crews', 'crew_members', 'equipment', 'dispatch_assignments',
    'route_checks', 'weather_checks', 'campaigns', 'campaign_recipients', 'reviews',
    'referrals', 'owner_briefings'
  ]
  loop
    execute format(
      'create policy %I_backoffice_select on public.%I for select using (public.has_company_role(company_id, array[''owner'', ''dispatcher'']::public.app_role[]))',
      table_name, table_name
    );
    execute format(
      'create policy %I_backoffice_insert on public.%I for insert with check (public.has_company_role(company_id, array[''owner'', ''dispatcher'']::public.app_role[]))',
      table_name, table_name
    );
    execute format(
      'create policy %I_backoffice_update on public.%I for update using (public.has_company_role(company_id, array[''owner'', ''dispatcher'']::public.app_role[])) with check (public.has_company_role(company_id, array[''owner'', ''dispatcher'']::public.app_role[]))',
      table_name, table_name
    );
    execute format(
      'create policy %I_backoffice_delete on public.%I for delete using (public.has_company_role(company_id, array[''owner'', ''dispatcher'']::public.app_role[]))',
      table_name, table_name
    );
  end loop;
end;
$$;

-- Owner-controlled configuration is readable by the roles that need it.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'service_catalog', 'checklist_templates', 'checklist_template_items', 'sds_documents',
    'materials'
  ]
  loop
    execute format(
      'create policy %I_member_select on public.%I for select using (public.has_company_role(company_id, array[''owner'', ''dispatcher'', ''technician'']::public.app_role[]))',
      table_name, table_name
    );
    execute format(
      'create policy %I_owner_insert on public.%I for insert with check (public.has_company_role(company_id, array[''owner'']::public.app_role[]))',
      table_name, table_name
    );
    execute format(
      'create policy %I_owner_update on public.%I for update using (public.has_company_role(company_id, array[''owner'']::public.app_role[])) with check (public.has_company_role(company_id, array[''owner'']::public.app_role[]))',
      table_name, table_name
    );
    execute format(
      'create policy %I_owner_delete on public.%I for delete using (public.has_company_role(company_id, array[''owner'']::public.app_role[]))',
      table_name, table_name
    );
  end loop;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'price_books', 'price_book_service_rules', 'price_book_attribute_multipliers',
    'price_book_add_ons', 'price_book_travel_zones'
  ]
  loop
    execute format(
      'create policy %I_staff_select on public.%I for select using (public.has_company_role(company_id, array[''owner'', ''dispatcher'']::public.app_role[]))',
      table_name, table_name
    );
    execute format(
      'create policy %I_owner_insert on public.%I for insert with check (public.has_company_role(company_id, array[''owner'']::public.app_role[]))',
      table_name, table_name
    );
    execute format(
      'create policy %I_owner_update on public.%I for update using (public.has_company_role(company_id, array[''owner'']::public.app_role[])) with check (public.has_company_role(company_id, array[''owner'']::public.app_role[]))',
      table_name, table_name
    );
    execute format(
      'create policy %I_owner_delete on public.%I for delete using (public.has_company_role(company_id, array[''owner'']::public.app_role[]))',
      table_name, table_name
    );
  end loop;
end;
$$;

create policy integration_connections_owner_select on public.integration_connections for select
  using (public.has_company_role(company_id, array['owner']::public.app_role[]));
create policy integration_connections_owner_insert on public.integration_connections for insert
  with check (public.has_company_role(company_id, array['owner']::public.app_role[]));
create policy integration_connections_owner_update on public.integration_connections for update
  using (public.has_company_role(company_id, array['owner']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner']::public.app_role[]));
create policy integration_connections_owner_delete on public.integration_connections for delete
  using (public.has_company_role(company_id, array['owner']::public.app_role[]));

create policy retention_policies_owner_select on public.retention_policies for select
  using (public.has_company_role(company_id, array['owner']::public.app_role[]));
create policy retention_policies_owner_insert on public.retention_policies for insert
  with check (public.has_company_role(company_id, array['owner']::public.app_role[]));
create policy retention_policies_owner_update on public.retention_policies for update
  using (public.has_company_role(company_id, array['owner']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner']::public.app_role[]));
create policy retention_runs_owner_select on public.retention_runs for select
  using (public.has_company_role(company_id, array['owner']::public.app_role[]));

-- Crew and equipment are readable by assigned field staff.
do $$
declare
  table_name text;
begin
  foreach table_name in array array['crews', 'crew_members', 'equipment']
  loop
    execute format(
      'create policy %I_technician_select on public.%I for select using (public.has_company_role(company_id, array[''technician'']::public.app_role[]))',
      table_name, table_name
    );
  end loop;
end;
$$;

create policy customers_staff_select on public.customers for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
);
create policy customers_backoffice_write on public.customers for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy customers_portal_update on public.customers for update
  using (public.is_customer_user(company_id, id))
  with check (public.is_customer_user(company_id, id));

create policy properties_select on public.properties for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
);
create policy properties_backoffice_write on public.properties for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));

create policy consents_select on public.consent_records for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
);
create policy consents_backoffice_write on public.consent_records for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy consents_customer_insert on public.consent_records for insert
  with check (customer_id is not null and public.is_customer_user(company_id, customer_id));

create policy measurements_select on public.property_measurements for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
);
create policy measurements_staff_insert on public.property_measurements for insert with check (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
  or (
    measured_by = auth.uid()
    and exists (
      select 1 from public.jobs j
      where j.property_id = property_measurements.property_id
        and public.is_assigned_technician_for_job(j.id)
    )
  )
);
create policy measurements_backoffice_update on public.property_measurements for update
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));

create policy photo_analyses_staff_select on public.photo_analyses for select
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy photo_analyses_service_insert on public.photo_analyses for insert
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));

create policy estimates_select on public.estimates for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
);
create policy estimates_backoffice_write on public.estimates for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy estimate_lines_select on public.estimate_lines for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
);
create policy estimate_lines_backoffice_write on public.estimate_lines for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));

create policy quotes_select on public.quotes for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
  or (
    public.is_customer_user(company_id, customer_id)
    and status not in ('draft', 'pending_approval', 'void')
  )
);
create policy quotes_backoffice_write on public.quotes for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy jobs_select on public.jobs for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
);
create policy jobs_backoffice_write on public.jobs for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));

create policy visits_select on public.visits for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
);
create policy visits_backoffice_write on public.visits for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy visits_technician_update on public.visits for update
  using (public.is_assigned_technician_for_visit(id))
  with check (public.is_assigned_technician_for_visit(id));

-- Visit-owned field records.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'visit_checklist_items', 'time_entries', 'material_usage', 'completion_signatures'
  ]
  loop
    execute format(
      'create policy %I_staff_select on public.%I for select using (public.has_company_role(company_id, array[''owner'', ''dispatcher'']::public.app_role[]) or public.is_assigned_technician_for_visit(visit_id))',
      table_name, table_name
    );
    execute format(
      'create policy %I_staff_insert on public.%I for insert with check (public.has_company_role(company_id, array[''owner'', ''dispatcher'']::public.app_role[]) or public.is_assigned_technician_for_visit(visit_id))',
      table_name, table_name
    );
    execute format(
      'create policy %I_staff_update on public.%I for update using (public.has_company_role(company_id, array[''owner'', ''dispatcher'']::public.app_role[]) or public.is_assigned_technician_for_visit(visit_id)) with check (public.has_company_role(company_id, array[''owner'', ''dispatcher'']::public.app_role[]) or public.is_assigned_technician_for_visit(visit_id))',
      table_name, table_name
    );
  end loop;
end;
$$;

create policy media_assets_select on public.media_assets for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
  or (visit_id is not null and public.is_assigned_technician_for_visit(visit_id))
  or (
    customer_visible and property_id is not null and exists (
      select 1 from public.properties p
      where p.id = media_assets.property_id and public.is_customer_user(p.company_id, p.customer_id)
    )
  )
);
create policy media_assets_staff_insert on public.media_assets for insert with check (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
  or (visit_id is not null and public.is_assigned_technician_for_visit(visit_id))
);
create policy media_assets_staff_update on public.media_assets for update
  using (
    public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
    or (visit_id is not null and public.is_assigned_technician_for_visit(visit_id))
  )
  with check (
    public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
    or (visit_id is not null and public.is_assigned_technician_for_visit(visit_id))
  );

create policy incidents_select on public.incidents for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
  or reported_by = auth.uid()
  or (visit_id is not null and public.is_assigned_technician_for_visit(visit_id))
);
create policy incidents_insert on public.incidents for insert with check (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
  or (
    public.has_company_role(company_id, array['technician']::public.app_role[])
    and reported_by = auth.uid()
    and (visit_id is null or public.is_assigned_technician_for_visit(visit_id))
  )
);
create policy incidents_backoffice_update on public.incidents for update
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));

-- Financial and customer engagement data.
create policy invoices_select on public.invoices for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
);
create policy invoices_backoffice_write on public.invoices for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy invoice_lines_select on public.invoice_lines for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
  or exists (
    select 1 from public.invoices i
    where i.id = invoice_lines.invoice_id and public.is_customer_user(i.company_id, i.customer_id)
  )
);
create policy invoice_lines_backoffice_write on public.invoice_lines for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy payments_select on public.payments for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
);

create policy communication_threads_select on public.communication_threads for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
  or (customer_id is not null and public.is_customer_user(company_id, customer_id))
);
create policy communication_threads_backoffice_write on public.communication_threads for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy communication_messages_select on public.communication_messages for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
  or exists (
    select 1 from public.communication_threads t
    where t.id = communication_messages.thread_id
      and t.customer_id is not null
      and public.is_customer_user(t.company_id, t.customer_id)
  )
);
create policy communication_messages_backoffice_write on public.communication_messages for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy communication_messages_customer_insert on public.communication_messages for insert with check (
  direction = 'inbound'
  and channel = 'portal'
  and delivery_status = 'received'
  and sent_by_user_id = auth.uid()
  and sent_by_agent is null
  and provider_message_id is null
  and exists (
    select 1 from public.communication_threads t
    where t.id = communication_messages.thread_id
      and t.customer_id is not null
      and public.is_customer_user(t.company_id, t.customer_id)
  )
);

create policy recurring_plans_select on public.recurring_maintenance_plans for select using (
  public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[])
  or public.is_customer_user(company_id, customer_id)
);
create policy recurring_plans_backoffice_write on public.recurring_maintenance_plans for all
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));

-- Approvals: dispatch may request/read; only owner may decide.
create policy approvals_select on public.approval_requests for select
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy approvals_request on public.approval_requests for insert
  with check (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy approvals_owner_update on public.approval_requests for update
  using (public.has_company_role(company_id, array['owner']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner']::public.app_role[]));

create policy automation_runs_select on public.automation_runs for select
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy automation_runs_owner_manage on public.automation_runs for all
  using (public.has_company_role(company_id, array['owner']::public.app_role[]))
  with check (public.has_company_role(company_id, array['owner']::public.app_role[]));

create policy ai_traces_select on public.ai_traces for select
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));
create policy audit_events_owner_select on public.audit_events for select
  using (public.has_company_role(company_id, array['owner']::public.app_role[]));

create policy notifications_select on public.notifications for select using (
  recipient_user_id = auth.uid()
  or (
    recipient_customer_id is not null
    and public.is_customer_user(company_id, recipient_customer_id)
  )
);
create policy notifications_recipient_update on public.notifications for update
  using (
    recipient_user_id = auth.uid()
    or (
      recipient_customer_id is not null
      and public.is_customer_user(company_id, recipient_customer_id)
    )
  )
  with check (
    recipient_user_id = auth.uid()
    or (
      recipient_customer_id is not null
      and public.is_customer_user(company_id, recipient_customer_id)
    )
  );

create policy search_documents_staff_select on public.search_documents for select
  using (public.has_company_role(company_id, array['owner', 'dispatcher']::public.app_role[]));

-- Trusted service-role tables intentionally have no authenticated policies:
-- webhook_events, idempotency_keys. Service role bypasses RLS.

-- Private storage buckets. Object paths begin with the company UUID.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'job-media',
    'job-media',
    false,
    26214400,
    array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
  ),
  (
    'sds',
    'sds',
    false,
    10485760,
    array['application/pdf']
  ),
  (
    'company-assets',
    'company-assets',
    false,
    5242880,
    array['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml']
  )
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_read_job_media_object(target_name text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.media_assets media
    left join public.properties property on property.id = media.property_id
    where media.object_path = target_name
      and (
        public.has_company_role(
          media.company_id,
          array['owner', 'dispatcher']::public.app_role[]
        )
        or (
          media.visit_id is not null
          and public.is_assigned_technician_for_visit(media.visit_id)
        )
        or (
          media.customer_visible
          and property.id is not null
          and public.is_customer_user(media.company_id, property.customer_id)
        )
      )
  );
$$;

create or replace function public.can_upload_job_media_object(target_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, storage
as $$
declare
  folders text[] := storage.foldername(target_name);
  target_company_id uuid;
  scope_id uuid;
begin
  if cardinality(folders) < 3
    or folders[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or folders[3] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    return false;
  end if;
  target_company_id := folders[1]::uuid;
  scope_id := folders[3]::uuid;
  if public.has_company_role(
    target_company_id,
    array['owner', 'dispatcher']::public.app_role[]
  ) then
    return folders[2] in ('visits', 'customers', 'incidents', 'scope');
  end if;
  if folders[2] = 'visits'
    and public.has_company_role(
      target_company_id,
      array['technician']::public.app_role[]
    )
  then
    return public.is_assigned_technician_for_visit(scope_id);
  end if;
  if folders[2] = 'customers'
    and public.has_company_role(
      target_company_id,
      array['customer']::public.app_role[]
    )
  then
    return public.is_customer_user(target_company_id, scope_id);
  end if;
  return false;
exception
  when invalid_text_representation then
    return false;
end;
$$;

revoke all on function public.can_read_job_media_object(text) from public;
revoke all on function public.can_upload_job_media_object(text) from public;
grant execute on function public.can_read_job_media_object(text) to authenticated, service_role;
grant execute on function public.can_upload_job_media_object(text) to authenticated, service_role;

create policy job_media_select on storage.objects for select to authenticated using (
  bucket_id = 'job-media'
  and public.can_read_job_media_object(name)
);

create policy job_media_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'job-media'
  and public.can_upload_job_media_object(name)
);

create policy job_media_update on storage.objects for update to authenticated
  using (
    bucket_id = 'job-media'
    and public.can_read_job_media_object(name)
    and public.has_company_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner', 'dispatcher', 'technician']::public.app_role[]
    )
  )
  with check (
    bucket_id = 'job-media'
    and public.can_read_job_media_object(name)
    and public.has_company_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner', 'dispatcher', 'technician']::public.app_role[]
    )
  );

create policy sds_select on storage.objects for select to authenticated using (
  bucket_id = 'sds'
  and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  and public.has_company_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner', 'dispatcher', 'technician']::public.app_role[]
  )
);
create policy sds_owner_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sds'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.has_company_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner']::public.app_role[]
    )
  );
create policy sds_owner_update on storage.objects for update to authenticated
  using (
    bucket_id = 'sds'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.has_company_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner']::public.app_role[]
    )
  )
  with check (
    bucket_id = 'sds'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.has_company_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner']::public.app_role[]
    )
  );

create policy company_assets_select on storage.objects for select to authenticated using (
  bucket_id = 'company-assets'
  and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  and public.has_company_role(
    ((storage.foldername(name))[1])::uuid,
    array['owner', 'dispatcher', 'technician']::public.app_role[]
  )
);
create policy company_assets_owner_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'company-assets'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.has_company_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner']::public.app_role[]
    )
  );
create policy company_assets_owner_update on storage.objects for update to authenticated
  using (
    bucket_id = 'company-assets'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.has_company_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner']::public.app_role[]
    )
  )
  with check (
    bucket_id = 'company-assets'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and public.has_company_role(
      ((storage.foldername(name))[1])::uuid,
      array['owner']::public.app_role[]
    )
  );

comment on table public.price_books is
  'Versioned deterministic pricing configuration. Published rows and children are immutable.';
comment on table public.property_measurements is
  'Billable measurements; photo-assisted entries retain source/confidence and verification state.';
comment on table public.audit_events is
  'Append-only security and business audit stream. Update/delete are rejected by trigger.';
comment on table public.ai_traces is
  'Append-only redacted agent/tool trace spans with retention metadata.';
comment on table public.idempotency_keys is
  'Server-only request deduplication ledger; never exposed directly to authenticated clients.';
