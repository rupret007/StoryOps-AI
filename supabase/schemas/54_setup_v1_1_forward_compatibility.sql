-- Forward-compatible setup V1.1 installation.
--
-- Migration 35 renamed the original setup implementation to the non-executable
-- V1.0 inner function. Updating migration 09 alone therefore updates fresh
-- databases but not databases that already installed that rename. Replace the
-- installed inner implementation in place, without changing its owner or ACL,
-- then reassert the fail-closed revocation.

create or replace function public.complete_storyops_setup_v1_0(
  p_company_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_business_name text,
  p_owner_name text,
  p_home_postal_code text,
  p_timezone text,
  p_enabled_service_codes text[],
  p_policy_acknowledged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  bootstrap_company_claim text := auth.jwt() #>> '{app_metadata,storyops_bootstrap_company_id}';
  actor_membership public.company_memberships%rowtype;
  company_record public.companies%rowtype;
  checklist_template_id uuid;
  service_code text;
  service_name text;
  service_description text;
  service_category text;
  required_skills text[];
  required_equipment text[];
  required_measurements text[];
  sop_reference text;
  setup_settings jsonb;
  current_setup_input jsonb;
  was_created boolean := false;
  prior_command_id text;
  prior_request_hash text;
  configured_service_count integer;
  available_service_count integer;
  disabled_integration_count integer;
  setup_completed_at timestamptz := now();
begin
  if actor_user_id is null then
    raise exception 'Authentication is required';
  end if;
  if p_company_id is null or p_command_id is null then
    raise exception 'Stable company and command IDs are required';
  end if;
  if p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Request hash must be a lowercase SHA-256 digest';
  end if;
  if length(btrim(coalesce(p_business_name, ''))) not between 2 and 80
    or btrim(p_business_name) ~ '[[:cntrl:]]'
  then
    raise exception 'Business name must be 2-80 printable characters';
  end if;
  if length(btrim(coalesce(p_owner_name, ''))) not between 2 and 80
    or btrim(p_owner_name) ~ '[[:cntrl:]]'
  then
    raise exception 'Owner name must be 2-80 printable characters';
  end if;
  if coalesce(p_home_postal_code, '') !~ '^[0-9]{5}$' then
    raise exception 'Home postal code must contain five digits';
  end if;
  if p_timezone <> 'America/Chicago' then
    raise exception 'Single-company DFW V1 requires America/Chicago';
  end if;
  if not coalesce(p_policy_acknowledged, false) then
    raise exception 'Setup policy acknowledgement is required';
  end if;
  if coalesce(cardinality(p_enabled_service_codes), 0) < 1
    or cardinality(p_enabled_service_codes) > 5
    or not (
      p_enabled_service_codes
      <@ array[
        'pressure-wash-flatwork',
        'soft-wash-house',
        'gutter-cleaning',
        'roof-washing',
        'window-cleaning'
      ]::text[]
    )
    or (
      select count(*) <> count(distinct candidate)
      from unnest(p_enabled_service_codes) candidate
    )
  then
    raise exception 'Select one to five unique supported services';
  end if;

  current_setup_input := jsonb_build_object(
    'businessName', btrim(p_business_name),
    'ownerName', btrim(p_owner_name),
    'homePostalCode', p_home_postal_code,
    'timezone', p_timezone,
    'enabledServiceCodes', to_jsonb(p_enabled_service_codes),
    'policyAcknowledged', true
  );

  perform pg_advisory_xact_lock(
    hashtextextended('storyops-setup:' || actor_user_id::text, 0)
  );

  select membership.*
  into actor_membership
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active
  for update;

  select company.*
  into company_record
  from public.companies company
  where company.id = p_company_id
  for update;

  if company_record.id is not null and actor_membership.id is null then
    raise exception 'No active company membership';
  end if;
  if actor_membership.id is not null and actor_membership.role <> 'owner' then
    raise exception 'Only an owner can complete company setup';
  end if;

  if company_record.id is null then
    if bootstrap_company_claim is distinct from p_company_id::text then
      raise exception 'Authenticated company bootstrap invitation is required';
    end if;
    if exists (
      select 1
      from public.company_memberships membership
      where membership.user_id = actor_user_id
        and membership.active
    ) then
      raise exception 'Single-company V1 does not allow another company scope';
    end if;
    if exists (
      select 1
      from public.customer_portal_users portal
      where portal.user_id = actor_user_id
    ) then
      raise exception 'Customer portal identities cannot provision a company';
    end if;

    insert into public.companies(id, name, timezone, currency, status, settings)
    values (
      p_company_id,
      btrim(p_business_name),
      p_timezone,
      'USD',
      'setup',
      '{}'::jsonb
    )
    returning * into company_record;

    insert into public.company_memberships(company_id, user_id, role, active)
    values (p_company_id, actor_user_id, 'owner', true)
    returning * into actor_membership;
    was_created := true;
  end if;

  prior_command_id := company_record.settings ->> 'setupCommandId';
  prior_request_hash := company_record.settings ->> 'setupRequestHash';
  if coalesce((company_record.settings ->> 'setupWizardCompleted')::boolean, false) then
    if prior_command_id = p_command_id::text
      and prior_request_hash = p_request_hash
      and company_record.settings -> 'setupInput' = current_setup_input
    then
      return jsonb_build_object(
        'schemaVersion', 'storyops-live-setup-v1',
        'status', 'configured',
        'companyId', p_company_id,
        'role', 'owner',
        'companyStatus', company_record.status,
        'setupComplete', true,
        'requiresLaunchReview', true,
        'replayed', true,
        'commandId', p_command_id,
        'requestHash', p_request_hash,
        'serviceCount', cardinality(p_enabled_service_codes),
        'availableServiceCount', 5,
        'integrationsDisabled', 10,
        'serverTime', coalesce(
          company_record.settings ->> 'setupCompletedAt',
          company_record.updated_at::text
        )
      );
    end if;
    raise exception 'Company setup is already complete with a different request';
  end if;

  if not was_created and (
    company_record.status <> 'setup'
    or coalesce((company_record.settings ->> 'launchAuthorized')::boolean, false)
    or (
      select count(*)
      from public.company_memberships membership
      where membership.company_id = p_company_id
        and membership.active
    ) <> 1
    or exists (
      select 1 from public.service_catalog record where record.company_id = p_company_id
      union all
      select 1 from public.checklist_templates record where record.company_id = p_company_id
      union all
      select 1 from public.price_books record where record.company_id = p_company_id
      union all
      select 1 from public.service_terms record where record.company_id = p_company_id
      union all
      select 1 from public.retention_policies record where record.company_id = p_company_id
      union all
      select 1 from public.integration_connections record where record.company_id = p_company_id
      union all
      select 1 from public.leads record where record.company_id = p_company_id
      union all
      select 1 from public.customers record where record.company_id = p_company_id
      union all
      select 1 from public.properties record where record.company_id = p_company_id
      union all
      select 1 from public.jobs record where record.company_id = p_company_id
      union all
      select 1 from public.invoices record where record.company_id = p_company_id
    )
  ) then
    raise exception
      'Existing company is not a pristine setup scope; use reviewed administrative migration';
  end if;

  insert into public.profiles(id, full_name)
  values (actor_user_id, btrim(p_owner_name))
  on conflict (id) do update
  set full_name = excluded.full_name, updated_at = now();

  setup_settings := company_record.settings || jsonb_build_object(
    'homePostalCode', p_home_postal_code,
    'enabledServiceCodes', to_jsonb(p_enabled_service_codes),
    'setupWizardCompleted', true,
    'setupCommandId', p_command_id,
    'setupRequestHash', p_request_hash,
    'setupInput', current_setup_input,
    'setupCompletedAt', setup_completed_at,
    'launchAuthorized', false,
    'requiredReviews', jsonb_build_array(
      'pricing',
      'terms',
      'tax',
      'safety',
      'environmental',
      'insurance',
      'privacy',
      'communications'
    )
  );

  update public.companies
  set
    name = btrim(p_business_name),
    timezone = p_timezone,
    status = 'setup',
    settings = setup_settings,
    updated_at = now()
  where id = p_company_id;

  insert into public.checklist_templates(
    company_id,
    name,
    version_label,
    active
  )
  values (
    p_company_id,
    'Setup review required - exterior service',
    'setup-draft-v1',
    false
  )
  on conflict (company_id, name, version_label) do update
  set active = false, updated_at = now()
  returning id into checklist_template_id;

  insert into public.checklist_template_items(
    company_id,
    template_id,
    item_key,
    label,
    item_kind,
    required,
    safety_critical,
    sort_order
  )
  values
    (
      p_company_id,
      checklist_template_id,
      'scope-and-hazards',
      'Confirm approved scope, access, hazards, and stop-work conditions',
      'boolean',
      true,
      true,
      10
    ),
    (
      p_company_id,
      checklist_template_id,
      'before-evidence',
      'Capture required before evidence',
      'photo',
      true,
      false,
      20
    ),
    (
      p_company_id,
      checklist_template_id,
      'after-evidence',
      'Capture required after evidence',
      'photo',
      true,
      false,
      30
    ),
    (
      p_company_id,
      checklist_template_id,
      'completion-signature',
      'Capture completion signature',
      'signature',
      true,
      false,
      40
    )
  on conflict (template_id, item_key) do nothing;

  foreach service_code in array array[
    'pressure-wash-flatwork',
    'soft-wash-house',
    'gutter-cleaning',
    'roof-washing',
    'window-cleaning'
  ]::text[]
  loop
    select
      supported.name,
      supported.description,
      supported.category,
      supported.skills,
      supported.equipment,
      supported.measurements,
      supported.sop
    into
      service_name,
      service_description,
      service_category,
      required_skills,
      required_equipment,
      required_measurements,
      sop_reference
    from (
      values
        (
          'pressure-wash-flatwork',
          'Pressure Wash Flatwork',
          'Pressure washing for verified, approved hardscape scope.',
          'pressure_washing',
          array['surface-identification', 'pressure-washing']::text[],
          array['pressure-washer', 'surface-cleaner']::text[],
          array['area_sq_ft']::text[],
          'SOP-PW-FLATWORK-001'
        ),
        (
          'soft-wash-house',
          'House Soft Wash',
          'Low-pressure exterior cleaning for verified, approved surfaces.',
          'soft_washing',
          array[
            'soft-washing',
            'siding-identification',
            'chemical-handling'
          ]::text[],
          array[
            'soft-wash-system',
            'chemical-metering',
            'plant-protection'
          ]::text[],
          array['area_sq_ft']::text[],
          'SOP-SW-HOUSE-001'
        ),
        (
          'gutter-cleaning',
          'Gutter Cleaning',
          'Debris removal and downspout flow verification for safe, approved access.',
          'gutter_cleaning',
          array['ladder-safety', 'gutter-cleaning']::text[],
          array['ladder', 'fall-protection', 'gutter-tools']::text[],
          array['length_linear_ft', 'count']::text[],
          'SOP-GUTTER-001'
        ),
        (
          'roof-washing',
          'Roof Soft Wash',
          'Low-pressure roof cleaning for verified, approved roof materials and access.',
          'roof_washing',
          array[
            'roof-soft-washing',
            'fall-protection',
            'chemical-handling'
          ]::text[],
          array[
            'soft-wash-system',
            'fall-protection',
            'plant-protection'
          ]::text[],
          array['area_sq_ft']::text[],
          'SOP-SW-ROOF-001'
        ),
        (
          'window-cleaning',
          'Exterior Window Cleaning',
          'Exterior window cleaning for verified panes, screens, tracks, stories, and access.',
          'window_cleaning',
          array['window-cleaning', 'ladder-safety']::text[],
          array['window-cleaning-kit', 'ladder']::text[],
          array['count']::text[],
          'SOP-WINDOW-001'
        )
    ) as supported(
      code,
      name,
      description,
      category,
      skills,
      equipment,
      measurements,
      sop
    )
    where supported.code = service_code;

    insert into public.service_catalog(
      company_id,
      code,
      name,
      description,
      category,
      active,
      taxable,
      required_skills,
      required_equipment_types,
      required_measurement_kinds,
      safety_sop_reference,
      default_checklist_template_id
    )
    values (
      p_company_id,
      service_code,
      service_name,
      service_description,
      service_category,
      false,
      true,
      required_skills,
      required_equipment,
      required_measurements,
      sop_reference,
      checklist_template_id
    )
    on conflict (company_id, code) do nothing;
  end loop;

  insert into public.price_books(
    company_id,
    name,
    version_label,
    status,
    effective_from,
    currency,
    company_minimum,
    default_tax_rate_pct,
    margin_floor_pct,
    automatic_discount_limit_pct,
    deposit_kind,
    deposit_value
  )
  values (
    p_company_id,
    'Setup draft - pricing review required',
    'setup-draft-v1',
    'draft',
    now(),
    'USD',
    0,
    0,
    0,
    0,
    'none',
    0
  )
  on conflict (company_id, version_label) do nothing;

  insert into public.service_terms(
    company_id,
    version_label,
    status,
    terms_text,
    effective_from
  )
  values (
    p_company_id,
    'setup-draft-v1',
    'draft',
    'UNAPPROVED SETUP DRAFT. Replace with jurisdiction-specific terms reviewed by qualified counsel before quoting or customer use.',
    now()
  )
  on conflict (company_id, version_label) do nothing;

  insert into public.retention_policies(
    company_id,
    version_label,
    status,
    effective_from,
    class_rules,
    legal_review_status
  )
  values (
    p_company_id,
    'setup-draft-v1',
    'draft',
    now(),
    '{
      "operational":{"days":1095,"review":"required"},
      "communication":{"days":730,"review":"required"},
      "ai_trace":{"days":90,"review":"required"},
      "audit":{"days":2555,"review":"required"},
      "safety":{"days":1460,"review":"required"}
    }'::jsonb,
    'required'
  )
  on conflict (company_id, version_label) do nothing;

  insert into public.integration_connections(
    company_id,
    provider,
    mode,
    status,
    configuration,
    capabilities
  )
  select
    p_company_id,
    provider,
    'disabled',
    'disabled',
    '{}'::jsonb,
    '{}'::text[]
  from unnest(array[
    'openai',
    'twilio',
    'email',
    'stripe',
    'google_calendar',
    'maps',
    'nws',
    'vroom',
    'signed_storage_targets',
    'quickbooks_export'
  ]::text[]) provider
  on conflict (company_id, provider) do nothing;

  select count(*)::integer
  into configured_service_count
  from public.service_catalog service
  where service.company_id = p_company_id
    and service.code = any(p_enabled_service_codes)
    and not service.active;

  select count(*)::integer
  into available_service_count
  from public.service_catalog service
  where service.company_id = p_company_id
    and service.code = any(array[
      'pressure-wash-flatwork',
      'soft-wash-house',
      'gutter-cleaning',
      'roof-washing',
      'window-cleaning'
    ]::text[])
    and not service.active;

  select count(*)::integer
  into disabled_integration_count
  from public.integration_connections integration
  where integration.company_id = p_company_id
    and integration.mode = 'disabled'
    and integration.status = 'disabled';

  if configured_service_count <> cardinality(p_enabled_service_codes)
    or available_service_count <> 5
    or disabled_integration_count <> 10
    or not exists (
      select 1
      from public.price_books price_book
      where price_book.company_id = p_company_id
        and price_book.version_label = 'setup-draft-v1'
        and price_book.status = 'draft'
    )
    or not exists (
      select 1
      from public.service_terms terms
      where terms.company_id = p_company_id
        and terms.version_label = 'setup-draft-v1'
        and terms.status = 'draft'
    )
    or not exists (
      select 1
      from public.retention_policies policy
      where policy.company_id = p_company_id
        and policy.version_label = 'setup-draft-v1'
        and policy.status = 'draft'
        and policy.legal_review_status = 'required'
    )
  then
    raise exception 'Setup artifacts did not reconcile to the fail-closed contract';
  end if;

  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data,
    request_id
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    'company.setup_completed',
    'company',
    p_company_id,
    jsonb_build_object(
      'companyCreated', was_created,
      'serviceCodes', p_enabled_service_codes,
      'companyStatus', 'setup',
      'providers', 'disabled',
      'priceBook', 'draft',
      'terms', 'draft',
      'retentionPolicy', 'draft',
      'launchAuthorized', false
    ),
    p_command_id::text
  );

  return jsonb_build_object(
    'schemaVersion', 'storyops-live-setup-v1',
    'status', 'configured',
    'companyId', p_company_id,
    'role', 'owner',
    'companyStatus', 'setup',
    'setupComplete', true,
    'requiresLaunchReview', true,
    'replayed', false,
    'commandId', p_command_id,
    'requestHash', p_request_hash,
    'serviceCount', configured_service_count,
    'availableServiceCount', available_service_count,
    'integrationsDisabled', disabled_integration_count,
    'serverTime', setup_completed_at
  );
end;
$$;

-- The inner implementation is reachable only through the finite wrapper that
-- holds a private transaction capability. CREATE OR REPLACE retains the
-- existing postgres ownership; explicitly retain the deny-by-default ACL.
revoke all on function public.complete_storyops_setup_v1_0(
  uuid, uuid, text, text, text, text, text, text[], boolean
) from public, anon, authenticated, service_role;

comment on function public.complete_storyops_setup_v1_0(
  uuid, uuid, text, text, text, text, text, text[], boolean
) is
  'Private setup implementation upgraded in place for the five-service V1.1 contract; callable only through the authenticated finite wrapper.';

-- Setup completion, launch authorization, and company lifecycle evidence remain
-- server-managed. This replacement forward-installs setupCompletedAt protection
-- on databases that installed migration 09 before that key was introduced.
create or replace function public.guard_company_system_state()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  trusted_function_owner name;
  protected_key text;
begin
  select pg_get_userbyid(routine.proowner)::name
  into trusted_function_owner
  from pg_proc routine
  where routine.oid =
    'public.complete_storyops_setup(uuid,uuid,text,text,text,text,text,text[],boolean)'::regprocedure;

  if old.status is distinct from new.status
    and current_user is distinct from trusted_function_owner
  then
    raise exception
      'Company lifecycle status is server-managed; use a reviewed finite command';
  end if;

  foreach protected_key in array array[
    'setupWizardCompleted',
    'setupCommandId',
    'setupRequestHash',
    'setupInput',
    'setupCompletedAt',
    'launchAuthorized',
    'requiredReviews',
    'enabledServiceCodes'
  ]
  loop
    if (old.settings -> protected_key) is distinct from
      (new.settings -> protected_key)
      and current_user is distinct from trusted_function_owner
    then
      raise exception
        'Company setup and launch evidence is server-managed; use a reviewed finite command';
    end if;
  end loop;

  return new;
end;
$$;

revoke all on function public.guard_company_system_state()
  from public, anon, authenticated, service_role;

-- Idempotent administrative backfill used by this migration and retained
-- private for restore/import verification. Existing reviewed service rows win:
-- the unique company/code conflict is never updated. Only missing templates are
-- inserted, always inactive, for companies with durable setup-completion
-- evidence.
create or replace function
  private.backfill_storyops_setup_service_templates_v1_1()
returns integer
language plpgsql
set search_path = pg_catalog, public, private
as $$
declare
  inserted_count integer;
begin
  with supported(
    code,
    name,
    description,
    category,
    skills,
    equipment,
    measurements,
    sop
  ) as (
    values
      (
        'pressure-wash-flatwork',
        'Pressure Wash Flatwork',
        'Pressure washing for verified, approved hardscape scope.',
        'pressure_washing',
        array['surface-identification', 'pressure-washing']::text[],
        array['pressure-washer', 'surface-cleaner']::text[],
        array['area_sq_ft']::text[],
        'SOP-PW-FLATWORK-001'
      ),
      (
        'soft-wash-house',
        'House Soft Wash',
        'Low-pressure exterior cleaning for verified, approved surfaces.',
        'soft_washing',
        array[
          'soft-washing',
          'siding-identification',
          'chemical-handling'
        ]::text[],
        array[
          'soft-wash-system',
          'chemical-metering',
          'plant-protection'
        ]::text[],
        array['area_sq_ft']::text[],
        'SOP-SW-HOUSE-001'
      ),
      (
        'gutter-cleaning',
        'Gutter Cleaning',
        'Debris removal and downspout flow verification for safe, approved access.',
        'gutter_cleaning',
        array['ladder-safety', 'gutter-cleaning']::text[],
        array['ladder', 'fall-protection', 'gutter-tools']::text[],
        array['length_linear_ft', 'count']::text[],
        'SOP-GUTTER-001'
      ),
      (
        'roof-washing',
        'Roof Soft Wash',
        'Low-pressure roof cleaning for verified, approved roof materials and access.',
        'roof_washing',
        array[
          'roof-soft-washing',
          'fall-protection',
          'chemical-handling'
        ]::text[],
        array[
          'soft-wash-system',
          'fall-protection',
          'plant-protection'
        ]::text[],
        array['area_sq_ft']::text[],
        'SOP-SW-ROOF-001'
      ),
      (
        'window-cleaning',
        'Exterior Window Cleaning',
        'Exterior window cleaning for verified panes, screens, tracks, stories, and access.',
        'window_cleaning',
        array['window-cleaning', 'ladder-safety']::text[],
        array['window-cleaning-kit', 'ladder']::text[],
        array['count']::text[],
        'SOP-WINDOW-001'
      )
  )
  insert into public.service_catalog(
    company_id,
    code,
    name,
    description,
    category,
    active,
    taxable,
    required_skills,
    required_equipment_types,
    required_measurement_kinds,
    safety_sop_reference,
    default_checklist_template_id
  )
  select
    company.id,
    supported.code,
    supported.name,
    supported.description,
    supported.category,
    false,
    true,
    supported.skills,
    supported.equipment,
    supported.measurements,
    supported.sop,
    setup_checklist.id
  from public.companies company
  cross join supported
  left join lateral (
    select template.id
    from public.checklist_templates template
    where template.company_id = company.id
      and template.name = 'Setup review required - exterior service'
      and template.version_label = 'setup-draft-v1'
    order by template.created_at, template.id
    limit 1
  ) setup_checklist on true
  where coalesce(
    (company.settings ->> 'setupWizardCompleted')::boolean,
    false
  )
  on conflict (company_id, code) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function
  private.backfill_storyops_setup_service_templates_v1_1()
  from public, anon, authenticated, service_role;

select private.backfill_storyops_setup_service_templates_v1_1();
