-- Explicit operating-baseline publication for WashOps company configuration.
-- A live-reviewed configuration remains inert until an owner executes this
-- finite command. The command publishes deterministic prices, packages, terms,
-- retention, selected catalog items, and owner-operated resources atomically.
-- It never enables an integration, sends a message, or moves money.

alter table public.price_book_attribute_multipliers
  add column approval_reason text,
  add column approval_summary text,
  add constraint price_book_attribute_multiplier_approval_complete
    check (
      num_nonnulls(approval_reason, approval_summary) in (0, 2)
      and (
        approval_reason is null
        or approval_reason in (
          'price_exception', 'large_discount', 'margin_below_floor', 'refund',
          'legal_message', 'safety_message', 'negative_review_response',
          'vendor_action', 'bank_action', 'destructive_change',
          'outside_price_book', 'outside_sop', 'uncertain_scope',
          'stale_availability', 'weather_exception', 'campaign_send', 'other'
        )
      )
      and (approval_summary is null or length(btrim(approval_summary)) between 5 and 300)
    );

alter table public.price_book_add_ons
  add column approval_reason text,
  add column approval_summary text,
  add constraint price_book_add_on_approval_complete
    check (
      num_nonnulls(approval_reason, approval_summary) in (0, 2)
      and (
        approval_reason is null
        or approval_reason in (
          'price_exception', 'large_discount', 'margin_below_floor', 'refund',
          'legal_message', 'safety_message', 'negative_review_response',
          'vendor_action', 'bank_action', 'destructive_change',
          'outside_price_book', 'outside_sop', 'uncertain_scope',
          'stale_availability', 'weather_exception', 'campaign_send', 'other'
        )
      )
      and (approval_summary is null or length(btrim(approval_summary)) between 5 and 300)
    );

create table public.service_packages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  price_book_id uuid not null references public.price_books(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9][A-Z0-9_]{1,79}$'),
  name text not null check (length(btrim(name)) between 2 and 100),
  description text not null check (length(btrim(description)) between 10 and 500),
  tier text not null check (tier in ('good', 'better', 'best')),
  created_at timestamptz not null default now(),
  unique (price_book_id, code)
);

create table public.service_package_components (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  package_id uuid not null references public.service_packages(id) on delete cascade,
  service_code text not null,
  required boolean not null,
  required_add_on_codes text[] not null default '{}',
  optional_add_on_codes text[] not null default '{}',
  sort_order integer not null check (sort_order >= 0),
  created_at timestamptz not null default now(),
  unique (package_id, service_code),
  unique (package_id, sort_order),
  check (array_position(required_add_on_codes, '') is null),
  check (array_position(optional_add_on_codes, '') is null),
  check (not required_add_on_codes && optional_add_on_codes)
);

create table public.company_vehicles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  configuration_key text not null check (configuration_key ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  kind text not null check (kind in ('truck', 'van', 'trailer', 'other')),
  capacity_note text not null check (length(btrim(capacity_note)) between 2 and 160),
  active boolean not null default true,
  configuration_revision integer not null check (configuration_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (company_id, configuration_key)
);

create table public.company_operating_baseline_publications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  configuration_version_id uuid not null
    references public.company_configuration_versions(id) on delete restrict,
  configuration_revision integer not null check (configuration_revision > 0),
  configuration_hash text not null check (configuration_hash ~ '^[a-f0-9]{64}$'),
  price_book_id uuid not null references public.price_books(id) on delete restrict,
  service_terms_id uuid not null references public.service_terms(id) on delete restrict,
  retention_policy_id uuid not null references public.retention_policies(id) on delete restrict,
  baseline_hash text not null check (baseline_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('active', 'retired')),
  review_reference text not null check (length(btrim(review_reference)) between 5 and 240),
  activated_by uuid not null references auth.users(id) on delete restrict,
  activated_at timestamptz not null default now(),
  retired_at timestamptz,
  command_id uuid not null,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, configuration_revision),
  unique (company_id, command_id),
  check ((status = 'active') = (retired_at is null))
);

create unique index company_operating_baseline_one_active_idx
  on public.company_operating_baseline_publications(company_id)
  where status = 'active';

create index service_packages_price_book_idx
  on public.service_packages(company_id, price_book_id, tier, code);

create or replace function public.protect_price_book_package()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  source_package_id uuid;
  source_price_book_id uuid;
  parent_status text;
begin
  if tg_table_name = 'service_packages' then
    source_price_book_id := case
      when tg_op = 'DELETE' then old.price_book_id
      else new.price_book_id
    end;
  else
    source_package_id := case
      when tg_op = 'DELETE' then old.package_id
      else new.package_id
    end;
    select package.price_book_id
    into source_price_book_id
    from public.service_packages package
    where package.id = source_package_id;
  end if;
  select price_book.status
  into parent_status
  from public.price_books price_book
  where price_book.id = source_price_book_id;
  if parent_status in ('active', 'retired') then
    raise exception 'Packages belonging to a published price book are immutable';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger service_packages_immutable
before insert or update or delete on public.service_packages
for each row execute function public.protect_price_book_package();

create trigger service_package_components_immutable
before insert or update or delete on public.service_package_components
for each row execute function public.protect_price_book_package();

create or replace function public.protect_company_operating_baseline()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Operating baseline publication history is immutable';
  end if;
  if not (
    old.status = 'active'
    and new.status = 'retired'
    and new.retired_at is not null
    and (
      to_jsonb(new) - array['status', 'retired_at', 'updated_at']::text[]
      = to_jsonb(old) - array['status', 'retired_at', 'updated_at']::text[]
    )
  ) then
    raise exception 'Operating baseline publication history is immutable';
  end if;
  return new;
end;
$$;

create trigger company_operating_baseline_immutable
before update or delete on public.company_operating_baseline_publications
for each row execute function public.protect_company_operating_baseline();

create trigger company_vehicles_touch
before update on public.company_vehicles
for each row execute function public.touch_record();

create trigger company_vehicles_audit
after insert or update or delete on public.company_vehicles
for each row execute function public.audit_mutation();

create or replace function public.publish_company_operating_baseline(
  p_company_id uuid,
  p_command_id uuid,
  p_configuration_revision integer,
  p_review_reference text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  configuration_record public.company_configuration_versions%rowtype;
  configuration jsonb;
  validation_issues jsonb;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  created_price_book_id uuid := gen_random_uuid();
  service_terms_id uuid := gen_random_uuid();
  retention_policy_id uuid := gen_random_uuid();
  baseline_id uuid := gen_random_uuid();
  configured_rule jsonb;
  configured_multiplier jsonb;
  configured_add_on jsonb;
  configured_zone jsonb;
  configured_package jsonb;
  configured_vehicle jsonb;
  configured_equipment jsonb;
  service_catalog_id uuid;
  service_rule_id uuid;
  package_id uuid;
  default_crew_id uuid;
  enabled_service_codes text[];
  version_label text;
  baseline_hash text;
  service_count integer := 0;
  package_count integer := 0;
  integration_state_before text;
  integration_state_after text;
  result jsonb;
begin
  if actor_user_id is null then
    raise exception 'Authentication is required';
  end if;
  if p_company_id is null or p_command_id is null or p_configuration_revision < 1 then
    raise exception 'Stable company, command, and configuration revision are required';
  end if;
  if length(btrim(coalesce(p_review_reference, ''))) not between 5 and 240 then
    raise exception 'An operating-baseline review reference is required';
  end if;
  if p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Request hash must be lowercase SHA-256';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role <> 'owner' then
    raise exception 'Only an active company owner can publish an operating baseline';
  end if;

  effective_request_hash := encode(extensions.digest(jsonb_build_object(
    'configurationRevision', p_configuration_revision,
    'reviewReference', btrim(p_review_reference)
  )::text, 'sha256'), 'hex');

  insert into public.idempotency_keys(company_id, scope, key, request_hash, expires_at)
  values (
    p_company_id,
    'company-operating-baseline-publish-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '2555 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;
  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys key_record
    where key_record.company_id = p_company_id
      and key_record.scope = 'company-operating-baseline-publish-v1'
      and key_record.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'Operating-baseline command ID was reused with a different payload';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'The same operating-baseline command is already in progress';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-operating-baseline:' || p_company_id::text,
    0
  ));

  select *
  into configuration_record
  from public.company_configuration_versions record
  where record.company_id = p_company_id
    and record.revision = p_configuration_revision
    and record.status = 'published'
  for share;
  if configuration_record.id is null then
    raise exception 'The exact published configuration revision is unavailable';
  end if;
  if configuration_record.publication_mode <> 'live' then
    raise exception 'Only a live-reviewed configuration can become an operating baseline';
  end if;
  if exists (
    select 1
    from public.company_operating_baseline_publications publication
    where publication.company_id = p_company_id
      and publication.configuration_revision = p_configuration_revision
  ) then
    raise exception 'This configuration revision already has an operating-baseline publication';
  end if;

  configuration := configuration_record.configuration;
  validation_issues := public.validate_company_configuration(
    p_company_id,
    configuration,
    'live'
  );
  if exists (
    select 1
    from jsonb_array_elements(validation_issues) issue
    where issue ->> 'severity' = 'blocking'
  ) then
    raise exception 'Operating baseline blocked by configuration validation: %', validation_issues;
  end if;
  select encode(extensions.digest(coalesce(jsonb_agg(jsonb_build_object(
    'id', integration.id,
    'provider', integration.provider,
    'mode', integration.mode,
    'status', integration.status,
    'secretReference', integration.secret_reference,
    'configuration', integration.configuration,
    'capabilities', integration.capabilities,
    'lastCheckedAt', integration.last_checked_at,
    'lastError', integration.last_error,
    'version', integration.version
  ) order by integration.provider), '[]'::jsonb)::text, 'sha256'), 'hex')
  into integration_state_before
  from public.integration_connections integration
  where integration.company_id = p_company_id;

  select array_agg(service_code order by service_code)
  into enabled_service_codes
  from jsonb_array_elements_text(
    configuration #> '{pricing,enabledServiceCodes}'
  ) service_code;
  if coalesce(cardinality(enabled_service_codes), 0) < 1 then
    raise exception 'Operating baseline requires at least one enabled service';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(configuration #> '{pricing,packages}') package
    cross join lateral jsonb_array_elements(package -> 'components') component
    where not (component ->> 'serviceCode' = any(enabled_service_codes))
  ) then
    raise exception 'Every published package component must reference an enabled service';
  end if;

  version_label := format(
    'config-r%s-%s',
    p_configuration_revision,
    left(configuration_record.configuration_hash, 12)
  );
  baseline_hash := encode(extensions.digest(jsonb_build_object(
    'configurationHash', configuration_record.configuration_hash,
    'configurationRevision', p_configuration_revision,
    'reviewReference', btrim(p_review_reference),
    'versionLabel', version_label
  )::text, 'sha256'), 'hex');

  update public.price_books
  set status = 'retired'
  where company_id = p_company_id and status = 'active';
  update public.service_terms
  set status = 'retired'
  where company_id = p_company_id and status = 'approved';
  update public.retention_policies
  set status = 'retired'
  where company_id = p_company_id and status = 'active';
  update public.company_operating_baseline_publications
  set status = 'retired', retired_at = now(), updated_at = now()
  where company_id = p_company_id and status = 'active';

  update public.service_catalog
  set active = code = any(enabled_service_codes)
  where company_id = p_company_id;

  insert into public.price_books(
    id, company_id, name, version_label, status, effective_from, currency,
    company_minimum, default_tax_rate_pct, margin_floor_pct,
    automatic_discount_limit_pct, deposit_kind, deposit_value
  )
  values (
    created_price_book_id,
    p_company_id,
    configuration #>> '{pricing,priceBookTemplateVersion}',
    version_label,
    'draft',
    now(),
    'USD',
    (configuration #>> '{pricing,companyMinimum}')::numeric,
    case
      when coalesce((configuration #>> '{pricing,taxEnabled}')::boolean, false)
        then (configuration #>> '{pricing,defaultTaxRatePercent}')::numeric
      else 0
    end,
    (configuration #>> '{pricing,marginFloorPercent}')::numeric,
    (configuration #>> '{pricing,automaticDiscountLimitPercent}')::numeric,
    case configuration #>> '{payments,depositKind}'
      when 'fixed' then 'flat'
      when 'percent' then 'percent'
      else 'none'
    end,
    (configuration #>> '{payments,depositValue}')::numeric
  );

  for configured_rule in
    select rule
    from jsonb_array_elements(configuration #> '{pricing,serviceRules}') rule
    where rule ->> 'serviceCode' = any(enabled_service_codes)
    order by rule ->> 'serviceCode'
  loop
    select catalog.id
    into service_catalog_id
    from public.service_catalog catalog
    where catalog.company_id = p_company_id
      and catalog.code = configured_rule ->> 'serviceCode'
      and catalog.active;
    if service_catalog_id is null then
      raise exception 'Enabled service catalog record is unavailable: %',
        configured_rule ->> 'serviceCode';
    end if;
    service_rule_id := gen_random_uuid();
    insert into public.price_book_service_rules(
      id, company_id, price_book_id, service_catalog_id, service_code,
      pricing_unit, base_price, unit_price, included_quantity, service_minimum,
      estimated_base_cost, estimated_unit_cost, duration_base_minutes,
      duration_minutes_per_unit, taxable, allowed_attribute_values
    )
    values (
      service_rule_id,
      p_company_id,
      created_price_book_id,
      service_catalog_id,
      configured_rule ->> 'serviceCode',
      configured_rule ->> 'pricingUnit',
      (configured_rule ->> 'basePrice')::numeric,
      (configured_rule ->> 'unitPrice')::numeric,
      (configured_rule ->> 'includedQuantity')::numeric,
      (configured_rule ->> 'serviceMinimum')::numeric,
      (configured_rule ->> 'estimatedBaseCost')::numeric,
      (configured_rule ->> 'estimatedUnitCost')::numeric,
      (configured_rule ->> 'durationBaseMinutes')::integer,
      (configured_rule ->> 'durationMinutesPerUnit')::numeric,
      (configured_rule ->> 'taxable')::boolean,
      configured_rule -> 'allowedAttributeValues'
    );
    service_count := service_count + 1;

    for configured_multiplier in
      select multiplier
      from jsonb_array_elements(configured_rule -> 'attributeMultipliers') multiplier
    loop
      insert into public.price_book_attribute_multipliers(
        company_id, service_rule_id, attribute, attribute_value, multiplier,
        approval_reason, approval_summary
      )
      values (
        p_company_id,
        service_rule_id,
        configured_multiplier ->> 'attribute',
        configured_multiplier ->> 'value',
        (configured_multiplier ->> 'multiplier')::numeric,
        configured_multiplier #>> '{approval,reason}',
        configured_multiplier #>> '{approval,summary}'
      );
    end loop;

    for configured_add_on in
      select add_on
      from jsonb_array_elements(configured_rule -> 'addOns') add_on
    loop
      insert into public.price_book_add_ons(
        company_id, service_rule_id, code, name, pricing_unit, unit_price,
        estimated_unit_cost, duration_minutes_per_unit, taxable,
        approval_reason, approval_summary
      )
      values (
        p_company_id,
        service_rule_id,
        configured_add_on ->> 'code',
        configured_add_on ->> 'name',
        configured_add_on ->> 'pricingUnit',
        (configured_add_on ->> 'unitPrice')::numeric,
        (configured_add_on ->> 'estimatedUnitCost')::numeric,
        (configured_add_on ->> 'durationMinutesPerUnit')::numeric,
        (configured_add_on ->> 'taxable')::boolean,
        configured_add_on #>> '{approval,reason}',
        configured_add_on #>> '{approval,summary}'
      );
    end loop;
  end loop;
  if service_count <> cardinality(enabled_service_codes) then
    raise exception 'Published service-rule count does not match enabled catalog count';
  end if;

  for configured_zone in
    select zone
    from jsonb_array_elements(configuration #> '{territory,travelZones}') zone
  loop
    insert into public.price_book_travel_zones(
      company_id, price_book_id, zone_code, name, fee, taxable,
      maximum_one_way_miles, postal_codes
    )
    values (
      p_company_id,
      created_price_book_id,
      configured_zone ->> 'code',
      configured_zone ->> 'name',
      (configured_zone ->> 'fee')::numeric,
      false,
      nullif(configured_zone ->> 'maximumMiles', '')::numeric,
      array(
        select postal_code
        from jsonb_array_elements_text(configured_zone -> 'postalCodes') postal_code
        order by postal_code
      )
    );
  end loop;

  for configured_package in
    select package
    from jsonb_array_elements(configuration #> '{pricing,packages}') package
    order by package ->> 'tier', package ->> 'code'
  loop
    package_id := gen_random_uuid();
    insert into public.service_packages(
      id, company_id, price_book_id, code, name, description, tier
    )
    values (
      package_id,
      p_company_id,
      created_price_book_id,
      configured_package ->> 'code',
      configured_package ->> 'name',
      configured_package ->> 'description',
      configured_package ->> 'tier'
    );
    insert into public.service_package_components(
      company_id, package_id, service_code, required,
      required_add_on_codes, optional_add_on_codes, sort_order
    )
    select
      p_company_id,
      package_id,
      component ->> 'serviceCode',
      (component ->> 'required')::boolean,
      array(
        select jsonb_array_elements_text(component -> 'requiredAddOnCodes')
      ),
      array(
        select jsonb_array_elements_text(component -> 'optionalAddOnCodes')
      ),
      component_ordinality::integer - 1
    from jsonb_array_elements(configured_package -> 'components')
      with ordinality as package_component(component, component_ordinality);
    package_count := package_count + 1;
  end loop;

  if not exists (
    select 1
    from public.service_packages package
    where package.price_book_id = created_price_book_id and package.tier = 'good'
  ) or not exists (
    select 1
    from public.service_packages package
    where package.price_book_id = created_price_book_id and package.tier = 'better'
  ) or not exists (
    select 1
    from public.service_packages package
    where package.price_book_id = created_price_book_id and package.tier = 'best'
  ) then
    raise exception 'Published price book requires good, better, and best packages';
  end if;

  update public.price_books
  set
    status = 'active',
    published_by = actor_user_id,
    published_at = now()
  where id = created_price_book_id;

  insert into public.service_terms(
    id, company_id, version_label, status, terms_text, review_reference,
    reviewed_by, reviewed_at, effective_from
  )
  values (
    service_terms_id,
    p_company_id,
    version_label,
    'approved',
    configuration #>> '{policies,termsText}',
    configuration #>> '{policies,legalReview,evidenceReference}',
    actor_user_id,
    now(),
    now()
  );

  insert into public.retention_policies(
    id, company_id, version_label, status, effective_from, class_rules,
    legal_review_status, approved_by, approved_at
  )
  values (
    retention_policy_id,
    p_company_id,
    version_label,
    'active',
    now(),
    jsonb_build_object(
      'operational', jsonb_build_object(
        'days', (configuration #>> '{policies,retentionDays,operational}')::integer,
        'review', 'approved'
      ),
      'communication', jsonb_build_object(
        'days', (configuration #>> '{policies,retentionDays,communications}')::integer,
        'review', 'approved'
      ),
      'ai_trace', jsonb_build_object(
        'days', (configuration #>> '{policies,retentionDays,aiTraces}')::integer,
        'review', 'approved'
      ),
      'audit', jsonb_build_object(
        'days', (configuration #>> '{policies,retentionDays,audit}')::integer,
        'review', 'approved'
      ),
      'safety', jsonb_build_object(
        'days', (configuration #>> '{policies,retentionDays,safety}')::integer,
        'review', 'approved'
      )
    ),
    'approved',
    actor_user_id,
    now()
  );

  select crew.id
  into default_crew_id
  from public.crews crew
  where crew.company_id = p_company_id
  order by crew.created_at, crew.id
  limit 1;
  if default_crew_id is null then
    insert into public.crews(
      company_id, name, active, lead_technician_id, skill_codes,
      home_base_postal_code
    )
    values (
      p_company_id,
      'Owner field crew',
      true,
      actor_user_id,
      array(
        select distinct skill
        from jsonb_array_elements(configuration #> '{people,crewMembers}') member
        cross join lateral jsonb_array_elements_text(member -> 'skills') skill
        where coalesce((member ->> 'active')::boolean, false)
          and member ->> 'role' = 'owner'
        order by skill
      ),
      configuration #>> '{territory,serviceAddress,postalCode}'
    )
    returning id into default_crew_id;
  else
    update public.crews
    set
      active = true,
      lead_technician_id = actor_user_id,
      skill_codes = array(
        select distinct skill
        from jsonb_array_elements(configuration #> '{people,crewMembers}') member
        cross join lateral jsonb_array_elements_text(member -> 'skills') skill
        where coalesce((member ->> 'active')::boolean, false)
          and member ->> 'role' = 'owner'
        order by skill
      ),
      home_base_postal_code = configuration #>> '{territory,serviceAddress,postalCode}'
    where id = default_crew_id;
  end if;
  insert into public.crew_members(company_id, crew_id, user_id)
  values (p_company_id, default_crew_id, actor_user_id)
  on conflict (crew_id, user_id, starts_on) do nothing;

  update public.company_vehicles
  set active = false
  where company_id = p_company_id;
  for configured_vehicle in
    select vehicle
    from jsonb_array_elements(configuration #> '{resources,vehicles}') vehicle
  loop
    insert into public.company_vehicles(
      company_id, configuration_key, name, kind, capacity_note, active,
      configuration_revision
    )
    values (
      p_company_id,
      configured_vehicle ->> 'id',
      configured_vehicle ->> 'name',
      configured_vehicle ->> 'kind',
      configured_vehicle ->> 'capacityNote',
      (configured_vehicle ->> 'active')::boolean,
      p_configuration_revision
    )
    on conflict (company_id, configuration_key) do update
    set
      name = excluded.name,
      kind = excluded.kind,
      capacity_note = excluded.capacity_note,
      active = excluded.active,
      configuration_revision = excluded.configuration_revision;
  end loop;

  update public.equipment
  set status = 'retired'
  where company_id = p_company_id and asset_tag like 'CONFIG-%';
  for configured_equipment in
    select equipment
    from jsonb_array_elements(configuration #> '{resources,equipment}') equipment
  loop
    insert into public.equipment(
      company_id, asset_tag, name, equipment_type, status, assigned_crew_id,
      last_inspection_at, notes
    )
    values (
      p_company_id,
      'CONFIG-' || upper(configured_equipment ->> 'id'),
      configured_equipment ->> 'name',
      configured_equipment ->> 'equipmentType',
      case
        when not (configured_equipment ->> 'active')::boolean then 'retired'
        when configured_equipment ->> 'inspectionStatus' = 'current' then 'available'
        else 'maintenance'
      end,
      default_crew_id,
      case
        when configured_equipment ->> 'inspectionStatus' = 'current' then now()
        else null
      end,
      format(
        'Configuration revision %s; quantity %s; inspection status %s.',
        p_configuration_revision,
        configured_equipment ->> 'quantity',
        configured_equipment ->> 'inspectionStatus'
      )
    )
    on conflict (company_id, asset_tag) do update
    set
      name = excluded.name,
      equipment_type = excluded.equipment_type,
      status = excluded.status,
      assigned_crew_id = excluded.assigned_crew_id,
      last_inspection_at = excluded.last_inspection_at,
      notes = excluded.notes;
  end loop;

  update public.companies
  set
    name = configuration #>> '{identity,displayName}',
    timezone = configuration #>> '{territory,timezone}',
    default_operational_retention_days =
      (configuration #>> '{policies,retentionDays,operational}')::integer,
    status = 'active',
    settings = settings || jsonb_build_object(
      'launchAuthorized', false,
      'operatingBaselinePublished', true,
      'operatingBaselineId', baseline_id,
      'operatingBaselineHash', baseline_hash,
      'operatingConfigurationRevision', p_configuration_revision,
      'operatingConfigurationHash', configuration_record.configuration_hash,
      'operatingActivatedAt', now(),
      'operatingReviewReference', btrim(p_review_reference),
      'enabledServiceCodes', to_jsonb(enabled_service_codes),
      'serviceAddress', configuration #> '{territory,serviceAddress}',
      'serviceAreaNote', configuration #>> '{territory,serviceAreaNote}',
      'businessHours', configuration #> '{schedule,businessHours}',
      'appointmentBufferMinutes',
        (configuration #>> '{schedule,appointmentBufferMinutes}')::integer,
      'minimumLeadTimeHours',
        (configuration #>> '{schedule,minimumLeadTimeHours}')::integer,
      'maximumBookingDays',
        (configuration #>> '{schedule,maximumBookingDays}')::integer,
      'acceptedPaymentMethods', configuration #> '{payments,acceptedMethods}',
      'engagement', configuration -> 'engagement',
      'providersActivatedByBaseline', false,
      'outboundEnabledByBaseline', false
    ),
    updated_at = now()
  where id = p_company_id;

  insert into public.company_operating_baseline_publications(
    id, company_id, configuration_version_id, configuration_revision,
    configuration_hash, price_book_id, service_terms_id, retention_policy_id,
    baseline_hash, status, review_reference, activated_by, command_id, request_hash
  )
  values (
    baseline_id,
    p_company_id,
    configuration_record.id,
    p_configuration_revision,
    configuration_record.configuration_hash,
    created_price_book_id,
    service_terms_id,
    retention_policy_id,
    baseline_hash,
    'active',
    btrim(p_review_reference),
    actor_user_id,
    p_command_id,
    effective_request_hash
  );

  select encode(extensions.digest(coalesce(jsonb_agg(jsonb_build_object(
    'id', integration.id,
    'provider', integration.provider,
    'mode', integration.mode,
    'status', integration.status,
    'secretReference', integration.secret_reference,
    'configuration', integration.configuration,
    'capabilities', integration.capabilities,
    'lastCheckedAt', integration.last_checked_at,
    'lastError', integration.last_error,
    'version', integration.version
  ) order by integration.provider), '[]'::jsonb)::text, 'sha256'), 'hex')
  into integration_state_after
  from public.integration_connections integration
  where integration.company_id = p_company_id;
  if integration_state_before is distinct from integration_state_after then
    raise exception 'Operating-baseline publication changed provider activation state';
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-operating-baseline-receipt-v1',
    'commandType', 'company.operating_baseline.publish',
    'status', 'active',
    'companyId', p_company_id,
    'configurationRevision', p_configuration_revision,
    'configurationHash', configuration_record.configuration_hash,
    'baselineId', baseline_id,
    'baselineHash', baseline_hash,
    'priceBookId', created_price_book_id,
    'priceBookVersion', version_label,
    'serviceTermsId', service_terms_id,
    'serviceTermsVersion', version_label,
    'retentionPolicyId', retention_policy_id,
    'retentionPolicyVersion', version_label,
    'serviceCount', service_count,
    'packageCount', package_count,
    'providersActivated', false,
    'outboundEnabled', false,
    'launchAuthorized', false,
    'reviewReference', btrim(p_review_reference),
    'commandId', p_command_id,
    'requestHash', effective_request_hash,
    'replayed', false,
    'serverTime', now()
  );
  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now(), updated_at = now()
  where id = reservation_id;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    'company.operating_baseline_published',
    'company_operating_baseline',
    baseline_id,
    jsonb_build_object(
      'configurationRevision', p_configuration_revision,
      'configurationHash', configuration_record.configuration_hash,
      'baselineHash', baseline_hash,
      'priceBookId', created_price_book_id,
      'serviceTermsId', service_terms_id,
      'retentionPolicyId', retention_policy_id,
      'serviceCount', service_count,
      'packageCount', package_count,
      'providersActivated', false,
      'outboundEnabled', false,
      'launchAuthorized', false,
      'reviewReference', btrim(p_review_reference)
    ),
    p_command_id::text
  );
  return result;
exception
  when invalid_text_representation
    or numeric_value_out_of_range
    or check_violation
    or not_null_violation
  then
    raise exception 'Operating baseline rejected malformed configuration values: %', sqlerrm;
end;
$$;

create or replace function public.get_company_operating_baseline_state(
  p_company_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  publication public.company_operating_baseline_publications%rowtype;
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
  if actor_role <> 'owner' then
    raise exception 'Only an active company owner can read operating-baseline state';
  end if;
  select *
  into publication
  from public.company_operating_baseline_publications record
  where record.company_id = p_company_id and record.status = 'active';
  if publication.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'schemaVersion', 'storyops-operating-baseline-state-v1',
    'status', publication.status,
    'companyId', publication.company_id,
    'configurationRevision', publication.configuration_revision,
    'configurationHash', publication.configuration_hash,
    'baselineId', publication.id,
    'baselineHash', publication.baseline_hash,
    'priceBookId', publication.price_book_id,
    'serviceTermsId', publication.service_terms_id,
    'retentionPolicyId', publication.retention_policy_id,
    'reviewReference', publication.review_reference,
    'activatedAt', publication.activated_at,
    'providersActivated', false,
    'outboundEnabled', false,
    'launchAuthorized', false
  );
end;
$$;

-- Re-publish the trusted price-book projection so approval requirements and
-- package definitions are available to server-side pricing and the workbench.
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
            'safety_sop_reference', catalog.safety_sop_reference,
            'required_measurement_kinds', catalog.required_measurement_kinds
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
          'multiplier', multiplier.multiplier::text,
          'approval_reason', multiplier.approval_reason,
          'approval_summary', multiplier.approval_summary
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
          'taxable', add_on.taxable,
          'approval_reason', add_on.approval_reason,
          'approval_summary', add_on.approval_summary
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
    ), '[]'::jsonb),
    'packages', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'code', package.code,
          'name', package.name,
          'description', package.description,
          'tier', package.tier,
          'components', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'serviceCode', component.service_code,
                'required', component.required,
                'requiredAddOnCodes', component.required_add_on_codes,
                'optionalAddOnCodes', component.optional_add_on_codes
              )
              order by component.sort_order
            )
            from public.service_package_components component
            where component.package_id = package.id
          ), '[]'::jsonb)
        )
        order by
          case package.tier when 'good' then 1 when 'better' then 2 else 3 end,
          package.code
      )
      from public.service_packages package
      where package.company_id = p_company_id
        and package.price_book_id = book.id
    ), '[]'::jsonb)
  );
end;
$$;

alter table public.service_packages enable row level security;
alter table public.service_package_components enable row level security;
alter table public.company_vehicles enable row level security;
alter table public.company_operating_baseline_publications enable row level security;

create policy service_packages_company_read
on public.service_packages for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher', 'technician']::public.app_role[]
  )
  or exists (
    select 1
    from public.customer_portal_users portal
    where portal.company_id = service_packages.company_id
      and portal.user_id = auth.uid()
  )
);

create policy service_package_components_company_read
on public.service_package_components for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher', 'technician']::public.app_role[]
  )
  or exists (
    select 1
    from public.customer_portal_users portal
    where portal.company_id = service_package_components.company_id
      and portal.user_id = auth.uid()
  )
);

create policy company_vehicles_staff_read
on public.company_vehicles for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher', 'technician']::public.app_role[]
  )
);

create policy company_vehicles_owner_write
on public.company_vehicles for all
using (public.has_company_role(company_id, array['owner']::public.app_role[]))
with check (public.has_company_role(company_id, array['owner']::public.app_role[]));

create policy company_operating_baseline_owner_read
on public.company_operating_baseline_publications for select
using (public.has_company_role(company_id, array['owner']::public.app_role[]));

revoke all on table
  public.service_packages,
  public.service_package_components,
  public.company_vehicles,
  public.company_operating_baseline_publications
from public, anon;
grant select on table
  public.service_packages,
  public.service_package_components,
  public.company_operating_baseline_publications
to authenticated;
grant select, insert, update, delete on table public.company_vehicles to authenticated;

revoke all on function public.protect_price_book_package()
  from public, anon, authenticated;
revoke all on function public.protect_company_operating_baseline()
  from public, anon, authenticated;
revoke all on function public.publish_company_operating_baseline(
  uuid, uuid, integer, text, text
) from public, anon;
grant execute on function public.publish_company_operating_baseline(
  uuid, uuid, integer, text, text
) to authenticated;
revoke all on function public.get_company_operating_baseline_state(uuid)
  from public, anon;
grant execute on function public.get_company_operating_baseline_state(uuid)
  to authenticated;
revoke all on function public.load_active_price_book_snapshot(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.load_active_price_book_snapshot(uuid, uuid)
  to service_role;

comment on function public.publish_company_operating_baseline(
  uuid, uuid, integer, text, text
) is
  'Idempotently materializes one exact live-reviewed company configuration without enabling providers, outbound delivery, or payments.';
comment on table public.company_operating_baseline_publications is
  'Immutable evidence linking one live-reviewed configuration to its active price book, packages, terms, and retention policy.';
