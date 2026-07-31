-- Versioned owner configuration for the reusable service-business core.
-- Drafts may be edited only through a finite idempotent command. Publication
-- snapshots the complete configuration and never enables providers, pricing,
-- terms, customer contact, payments, or company launch by itself.

alter table public.price_book_attribute_multipliers
  drop constraint price_book_attribute_multipliers_attribute_check;
alter table public.price_book_attribute_multipliers
  add constraint price_book_attribute_multipliers_attribute_check
  check (attribute in (
    'stories', 'surface', 'soil', 'access', 'risk',
    'siding_material', 'organic_growth', 'gutter_guards', 'roof_access',
    'debris', 'roof_pitch', 'roof_material', 'service_side', 'screens', 'tracks'
  ));

create table public.company_configuration_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  revision integer not null check (revision > 0),
  schema_version text not null check (schema_version = 'storyops-company-config-v1'),
  status text not null check (status in ('draft', 'published', 'retired', 'superseded')),
  publication_mode text check (publication_mode in ('sandbox', 'live')),
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  configuration_hash text not null check (configuration_hash ~ '^[a-f0-9]{64}$'),
  review_reference text,
  created_by uuid not null references auth.users(id) on delete restrict,
  published_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (company_id, revision),
  check (
    (status in ('published', 'retired') and publication_mode is not null and published_by is not null
      and published_at is not null and review_reference is not null)
    or (status in ('draft', 'superseded') and published_at is null)
  )
);

create unique index company_configuration_one_draft_idx
  on public.company_configuration_versions(company_id)
  where status = 'draft';

create unique index company_configuration_one_published_idx
  on public.company_configuration_versions(company_id)
  where status = 'published';

create index company_configuration_history_idx
  on public.company_configuration_versions(company_id, revision desc);

create or replace function public.guard_published_company_configuration()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' and old.status in ('published', 'retired') then
    raise exception 'Published company configuration history is immutable';
  end if;
  if tg_op = 'UPDATE' and old.status in ('published', 'retired') then
    if not (
      old.status = 'published'
      and new.status = 'retired'
      and to_jsonb(new) - array['status', 'updated_at']::text[]
        = to_jsonb(old) - array['status', 'updated_at']::text[]
    ) then
      raise exception 'Published company configuration history is immutable';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger company_configuration_immutable
before update or delete on public.company_configuration_versions
for each row execute function public.guard_published_company_configuration();

create or replace function public.validate_company_configuration(
  p_company_id uuid,
  p_configuration jsonb,
  p_publication_mode text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  issues jsonb := '[]'::jsonb;
  enabled_code text;
  provider_count integer;
  review_section text;
  review_label text;
  review_record jsonb;
  reviewed_at_value timestamptz;
  review_invalid boolean;
  configured_rule jsonb;
  configured_required_measurement_kinds text[];
  catalog_required_measurement_kinds text[];
  expected_primary_measurement_kind text;
  multiplier_matrix_invalid boolean;
begin
  if p_publication_mode not in ('sandbox', 'live') then
    return jsonb_build_array(jsonb_build_object(
      'section', 'identity',
      'code', 'publication_mode_invalid',
      'message', 'Publication mode must be sandbox or live.',
      'severity', 'blocking'
    ));
  end if;
  if p_configuration is null
    or jsonb_typeof(p_configuration) <> 'object'
    or p_configuration ->> 'schemaVersion' <> 'storyops-company-config-v1'
  then
    return jsonb_build_array(jsonb_build_object(
      'section', 'identity',
      'code', 'schema_invalid',
      'message', 'Configuration schemaVersion is missing or unsupported.',
      'severity', 'blocking'
    ));
  end if;
  if not p_configuration ?& array[
    'identity', 'territory', 'schedule', 'pricing', 'people', 'resources',
    'materials', 'payments', 'policies', 'engagement', 'integrations'
  ] then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'identity',
      'code', 'section_missing',
      'message', 'Every required owner-configuration section must be present.',
      'severity', 'blocking'
    ));
  end if;
  if lower(p_configuration::text)
    ~ '"(api[_-]?key|client[_-]?secret|password|private[_-]?key|access[_-]?token|refresh[_-]?token)"[[:space:]]*:'
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'integrations',
      'code', 'secret_material_rejected',
      'message', 'Configuration records cannot contain provider secrets or tokens.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{pricing,enabledServiceCodes}') <> 'array'
    or jsonb_array_length(p_configuration #> '{pricing,enabledServiceCodes}') < 1
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'pricing',
      'code', 'services_missing',
      'message', 'At least one enabled service code is required.',
      'severity', 'blocking'
    ));
  else
    for enabled_code in
      select jsonb_array_elements_text(p_configuration #> '{pricing,enabledServiceCodes}')
    loop
      if not exists (
        select 1
        from public.service_catalog service
        where service.company_id = p_company_id
          and service.code = enabled_code
      ) then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'section', 'pricing',
          'code', 'service_not_provisioned',
          'message', 'Enabled service is not present in the company catalog: ' || enabled_code,
          'severity', 'blocking'
        ));
      end if;
    end loop;
  end if;
  if jsonb_typeof(p_configuration #> '{pricing,serviceRules}') <> 'array'
    or jsonb_array_length(p_configuration #> '{pricing,serviceRules}') < 1
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'pricing',
      'code', 'service_rules_missing',
      'message', 'Deterministic configured service rules are required.',
      'severity', 'blocking'
    ));
  else
    for enabled_code in
      select jsonb_array_elements_text(p_configuration #> '{pricing,enabledServiceCodes}')
    loop
      select rule
      into configured_rule
      from jsonb_array_elements(p_configuration #> '{pricing,serviceRules}') rule
      where rule ->> 'serviceCode' = enabled_code
      limit 1;
      if configured_rule is null then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'section', 'pricing',
          'code', 'enabled_service_rule_missing',
          'message', 'Enabled service lacks a deterministic configured rule: ' || enabled_code,
          'severity', 'blocking'
        ));
        continue;
      end if;
      if (
        select count(*)
        from jsonb_array_elements(p_configuration #> '{pricing,serviceRules}') rule
        where rule ->> 'serviceCode' = enabled_code
      ) <> 1 then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'section', 'pricing',
          'code', 'service_rule_duplicate',
          'message', 'Enabled service must have exactly one configured rule: ' || enabled_code,
          'severity', 'blocking'
        ));
      end if;

      select catalog.required_measurement_kinds
      into catalog_required_measurement_kinds
      from public.service_catalog catalog
      where catalog.company_id = p_company_id
        and catalog.code = enabled_code
      limit 1;
      configured_required_measurement_kinds := null;
      expected_primary_measurement_kind := case configured_rule ->> 'pricingUnit'
        when 'flat' then 'count'
        when 'sq_ft' then 'area_sq_ft'
        when 'linear_ft' then 'length_linear_ft'
        when 'each' then 'count'
        when 'hour' then 'duration_hours'
        else null
      end;
      if jsonb_typeof(configured_rule -> 'requiredMeasurementKinds') = 'array'
        and jsonb_array_length(configured_rule -> 'requiredMeasurementKinds') > 0
        and not exists (
          select 1
          from jsonb_array_elements(
            configured_rule -> 'requiredMeasurementKinds'
          ) measurement_kind
          where jsonb_typeof(measurement_kind) <> 'string'
        )
      then
        select array_agg(measurement_kind #>> '{}' order by measurement_ordinality)
        into configured_required_measurement_kinds
        from jsonb_array_elements(
          configured_rule -> 'requiredMeasurementKinds'
        ) with ordinality as configured_kind(
          measurement_kind,
          measurement_ordinality
        );
      end if;
      if expected_primary_measurement_kind is null
        or configured_required_measurement_kinds is null
        or catalog_required_measurement_kinds is null
        or configured_required_measurement_kinds
          is distinct from catalog_required_measurement_kinds
        or configured_required_measurement_kinds[1]
          is distinct from expected_primary_measurement_kind
        or catalog_required_measurement_kinds[1]
          is distinct from expected_primary_measurement_kind
        or cardinality(configured_required_measurement_kinds) is distinct from (
          select count(distinct measurement_kind)
          from unnest(configured_required_measurement_kinds) measurement_kind
        )
        or cardinality(catalog_required_measurement_kinds) is distinct from (
          select count(distinct measurement_kind)
          from unnest(catalog_required_measurement_kinds) measurement_kind
        )
      then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'section', 'pricing',
          'code', 'service_rule_measurement_semantics_mismatch',
          'message', 'Enabled service pricing unit and primary-first measurement kinds must exactly match its catalog: ' || enabled_code,
          'severity', 'blocking'
        ));
      end if;

      multiplier_matrix_invalid :=
        coalesce(
          jsonb_typeof(configured_rule -> 'allowedAttributeValues'),
          'missing'
        ) <> 'object'
        or coalesce(
          jsonb_typeof(configured_rule -> 'attributeMultipliers'),
          'missing'
        ) <> 'array';
      if not multiplier_matrix_invalid then
        multiplier_matrix_invalid := exists (
          select 1
          from jsonb_each(
            configured_rule -> 'allowedAttributeValues'
          ) allowed(attribute, allowed_values)
          where jsonb_typeof(allowed.allowed_values) <> 'array'
        );
      end if;
      if not multiplier_matrix_invalid then
        multiplier_matrix_invalid := exists (
          select 1
          from jsonb_each(
            configured_rule -> 'allowedAttributeValues'
          ) allowed(attribute, allowed_values)
          where jsonb_array_length(allowed.allowed_values) < 1
            or exists (
              select 1
              from jsonb_array_elements(allowed.allowed_values) allowed_value
              where jsonb_typeof(allowed_value) <> 'string'
                or nullif(btrim(allowed_value #>> '{}'), '') is null
            )
        );
      end if;
      if not multiplier_matrix_invalid then
        multiplier_matrix_invalid := exists (
          select 1
          from jsonb_array_elements(
            configured_rule -> 'attributeMultipliers'
          ) multiplier
          where jsonb_typeof(multiplier) <> 'object'
            or jsonb_typeof(multiplier -> 'attribute') <> 'string'
            or jsonb_typeof(multiplier -> 'value') <> 'string'
            or nullif(btrim(multiplier ->> 'attribute'), '') is null
            or nullif(btrim(multiplier ->> 'value'), '') is null
        );
      end if;
      if not multiplier_matrix_invalid then
        multiplier_matrix_invalid := exists (
          select 1
          from jsonb_each(
            configured_rule -> 'allowedAttributeValues'
          ) allowed(attribute, allowed_values)
          cross join lateral jsonb_array_elements_text(
            allowed.allowed_values
          ) allowed_value
          group by allowed.attribute, allowed_value
          having count(*) <> 1
        );
      end if;
      if not multiplier_matrix_invalid then
        multiplier_matrix_invalid := exists (
          select 1
          from jsonb_array_elements(
            configured_rule -> 'attributeMultipliers'
          ) multiplier
          group by multiplier ->> 'attribute', multiplier ->> 'value'
          having count(*) <> 1
        );
      end if;
      if not multiplier_matrix_invalid then
        multiplier_matrix_invalid := exists (
          select 1
          from jsonb_each(
            configured_rule -> 'allowedAttributeValues'
          ) allowed(attribute, allowed_values)
          cross join lateral jsonb_array_elements_text(
            allowed.allowed_values
          ) allowed_value
          where not exists (
            select 1
            from jsonb_array_elements(
              configured_rule -> 'attributeMultipliers'
            ) multiplier
            where multiplier ->> 'attribute' = allowed.attribute
              and multiplier ->> 'value' = allowed_value
          )
        );
      end if;
      if not multiplier_matrix_invalid then
        multiplier_matrix_invalid := exists (
          select 1
          from jsonb_array_elements(
            configured_rule -> 'attributeMultipliers'
          ) multiplier
          where not exists (
            select 1
            from jsonb_each(
              configured_rule -> 'allowedAttributeValues'
            ) allowed(attribute, allowed_values)
            cross join lateral jsonb_array_elements_text(
              allowed.allowed_values
            ) allowed_value
            where allowed.attribute = multiplier ->> 'attribute'
              and allowed_value = multiplier ->> 'value'
          )
        );
      end if;
      if multiplier_matrix_invalid then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'section', 'pricing',
          'code', 'service_rule_multiplier_matrix_invalid',
          'message', 'Every allowed attribute value must have one exact multiplier and no multiplier may be missing, extra, or duplicated: ' || enabled_code,
          'severity', 'blocking'
        ));
      end if;
    end loop;
  end if;
  if jsonb_typeof(p_configuration #> '{pricing,packages}') <> 'array'
    or not coalesce((
      select array_agg(distinct package ->> 'tier')
        @> array['good', 'better', 'best']::text[]
      from jsonb_array_elements(p_configuration #> '{pricing,packages}') package
    ), false)
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'pricing',
      'code', 'package_tiers_incomplete',
      'message', 'Good, better, and best configured packages are required.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{pricing,packages}') = 'array'
    and exists (
      select 1
      from jsonb_array_elements(p_configuration #> '{pricing,packages}') package
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object(
          'serviceCode', component ->> 'serviceCode',
          'required', component -> 'required',
          'requiredAddOnCodes', coalesce((
            select jsonb_agg(required_add_on.code order by required_add_on.code)
            from jsonb_array_elements_text(
              coalesce(component -> 'requiredAddOnCodes', '[]'::jsonb)
            ) required_add_on(code)
          ), '[]'::jsonb),
          'optionalAddOnCodes', coalesce((
            select jsonb_agg(optional_add_on.code order by optional_add_on.code)
            from jsonb_array_elements_text(
              coalesce(component -> 'optionalAddOnCodes', '[]'::jsonb)
            ) optional_add_on(code)
          ), '[]'::jsonb)
        ) order by component ->> 'serviceCode'), '[]'::jsonb) signature
        from jsonb_array_elements(package -> 'components') component
      ) normalized_scope
      group by normalized_scope.signature
      having count(*) <> 1
    )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'pricing',
      'code', 'package_scope_duplicate',
      'message', 'Good, better, and best packages must have distinct exact component scopes.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{pricing,packages}') = 'array'
    and jsonb_typeof(p_configuration #> '{pricing,enabledServiceCodes}') = 'array'
    and exists (
      select 1
      from jsonb_array_elements(p_configuration #> '{pricing,packages}') package
      cross join lateral jsonb_array_elements(package -> 'components') component
      where not exists (
        select 1
        from jsonb_array_elements_text(
          p_configuration #> '{pricing,enabledServiceCodes}'
        ) enabled_service
        where enabled_service = component ->> 'serviceCode'
      )
    )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'pricing',
      'code', 'package_service_not_enabled',
      'message', 'Every package component must reference an enabled service.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{pricing,packages}') = 'array'
    and jsonb_typeof(p_configuration #> '{pricing,serviceRules}') = 'array'
    and exists (
      select 1
      from jsonb_array_elements(p_configuration #> '{pricing,packages}') package
      cross join lateral jsonb_array_elements(package -> 'components') component
      cross join lateral jsonb_array_elements_text(
        coalesce(component -> 'requiredAddOnCodes', '[]'::jsonb)
        || coalesce(component -> 'optionalAddOnCodes', '[]'::jsonb)
      ) referenced_add_on
      where not exists (
        select 1
        from jsonb_array_elements(p_configuration #> '{pricing,serviceRules}') rule
        cross join lateral jsonb_array_elements(rule -> 'addOns') add_on
        where rule ->> 'serviceCode' = component ->> 'serviceCode'
          and add_on ->> 'code' = referenced_add_on
      )
    )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'pricing',
      'code', 'package_add_on_unresolved',
      'message', 'Every package add-on must resolve to its configured service rule.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{schedule,businessHours}') <> 'array'
    or jsonb_array_length(p_configuration #> '{schedule,businessHours}') <> 7
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'schedule',
      'code', 'business_hours_incomplete',
      'message', 'Exactly seven business-hour records are required.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{territory,travelZones}') <> 'array'
    or jsonb_array_length(p_configuration #> '{territory,travelZones}') < 1
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'territory',
      'code', 'travel_zones_missing',
      'message', 'At least one travel zone is required.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{people,crewMembers}') <> 'array'
    or not exists (
      select 1
      from jsonb_array_elements(p_configuration #> '{people,crewMembers}') member
      where coalesce((member ->> 'active')::boolean, false)
    )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'people',
      'code', 'active_crew_missing',
      'message', 'At least one active crew member is required.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{people,crewMembers}') <> 'array' then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'people',
      'code', 'active_owner_required',
      'message', 'Single-owner V1 requires exactly one active configured owner.',
      'severity', 'blocking'
    ));
  elsif (
      select count(*)
      from jsonb_array_elements(p_configuration #> '{people,crewMembers}') member
      where coalesce((member ->> 'active')::boolean, false)
        and member ->> 'role' = 'owner'
    ) <> 1
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'people',
      'code', 'active_owner_required',
      'message', 'Single-owner V1 requires exactly one active configured owner.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{resources,vehicles}') <> 'array'
    or not exists (
      select 1
      from jsonb_array_elements(p_configuration #> '{resources,vehicles}') vehicle
      where coalesce((vehicle ->> 'active')::boolean, false)
    )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'resources',
      'code', 'active_vehicle_missing',
      'message', 'At least one active service vehicle is required.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{resources,equipment}') <> 'array'
    or not exists (
      select 1
      from jsonb_array_elements(p_configuration #> '{resources,equipment}') equipment
      where coalesce((equipment ->> 'active')::boolean, false)
        and equipment ->> 'inspectionStatus' = 'current'
    )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'resources',
      'code', 'inspected_equipment_missing',
      'message', 'At least one active item of equipment needs a current inspection.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{pricing,enabledServiceCodes}') = 'array'
    and jsonb_typeof(p_configuration #> '{people,crewMembers}') = 'array'
    and exists (
      select 1
      from jsonb_array_elements_text(
        p_configuration #> '{pricing,enabledServiceCodes}'
      ) enabled_service(code)
      join public.service_catalog service
        on service.company_id = p_company_id
       and service.code = enabled_service.code
      cross join lateral unnest(service.required_skills) required_skill(code)
      where not exists (
        select 1
        from jsonb_array_elements(
          p_configuration #> '{people,crewMembers}'
        ) member
        cross join lateral jsonb_array_elements_text(
          coalesce(member -> 'skills', '[]'::jsonb)
        ) configured_skill(code)
        where coalesce((member ->> 'active')::boolean, false)
          and member ->> 'role' = 'owner'
          and configured_skill.code = required_skill.code
      )
    )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'people',
      'code', 'service_skill_coverage_missing',
      'message', 'The active configured owner must cover every enabled service catalog skill requirement; planning personnel do not satisfy this gate.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{pricing,enabledServiceCodes}') = 'array'
    and jsonb_typeof(p_configuration #> '{resources,equipment}') = 'array'
    and exists (
      select 1
      from jsonb_array_elements_text(
        p_configuration #> '{pricing,enabledServiceCodes}'
      ) enabled_service(code)
      join public.service_catalog service
        on service.company_id = p_company_id
       and service.code = enabled_service.code
      cross join lateral unnest(
        service.required_equipment_types
      ) required_equipment(code)
      where not exists (
        select 1
        from jsonb_array_elements(
          p_configuration #> '{resources,equipment}'
        ) equipment
        where coalesce((equipment ->> 'active')::boolean, false)
          and equipment ->> 'inspectionStatus' = 'current'
          and equipment ->> 'equipmentType' = required_equipment.code
      )
    )
  then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'resources',
      'code', 'service_equipment_coverage_missing',
      'message', 'Current active equipment must cover every enabled service catalog requirement.',
      'severity', 'blocking'
    ));
  end if;
  if jsonb_typeof(p_configuration #> '{integrations,providers}') <> 'array' then
    issues := issues || jsonb_build_array(jsonb_build_object(
      'section', 'integrations',
      'code', 'provider_matrix_missing',
      'message', 'The provider activation matrix is required.',
      'severity', 'blocking'
    ));
  else
    select count(distinct provider ->> 'provider')
    into provider_count
    from jsonb_array_elements(p_configuration #> '{integrations,providers}') provider;
    if provider_count <> 10 then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'section', 'integrations',
        'code', 'provider_matrix_incomplete',
        'message', 'Exactly ten unique provider readiness records are required.',
        'severity', 'blocking'
      ));
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_configuration #> '{integrations,providers}') provider
      where provider ->> 'requestedMode' = 'live'
        and (
          not coalesce((provider ->> 'environmentEnabled')::boolean, false)
          or not coalesce((provider ->> 'ownerEnabled')::boolean, false)
          or provider ->> 'health' <> 'healthy'
        )
    ) then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'section', 'integrations',
        'code', 'live_provider_not_ready',
        'message', 'Live provider requests require both switches and healthy evidence.',
        'severity', 'blocking'
      ));
    end if;
  end if;
  for review_section, review_label, review_record in
    select review.section, review.label, review.evidence
    from (
      values
        (
          'territory',
          'Travel-zone mapping',
          p_configuration #> '{territory,travelZoneMappingReview}'
        ),
        ('pricing', 'Tax', p_configuration #> '{pricing,taxReview}'),
        ('policies', 'Legal', p_configuration #> '{policies,legalReview}'),
        ('policies', 'Privacy', p_configuration #> '{policies,privacyReview}'),
        ('policies', 'Safety', p_configuration #> '{policies,safetyReview}'),
        ('policies', 'Insurance', p_configuration #> '{policies,insuranceReview}'),
        (
          'policies',
          'Environmental',
          p_configuration #> '{policies,environmentalReview}'
        )
    ) as review(section, label, evidence)
  loop
    if review_record ->> 'status' = 'approved' then
      review_invalid :=
        jsonb_typeof(review_record) is distinct from 'object'
        or not review_record ?& array[
          'status', 'reviewer', 'reviewedAt', 'evidenceReference'
        ]
        or (
          select count(*) from jsonb_object_keys(review_record)
        ) <> 4
        or jsonb_typeof(review_record -> 'status') is distinct from 'string'
        or jsonb_typeof(review_record -> 'reviewer') is distinct from 'string'
        or jsonb_typeof(review_record -> 'reviewedAt') is distinct from 'string'
        or jsonb_typeof(review_record -> 'evidenceReference') is distinct from 'string'
        or length(btrim(coalesce(review_record ->> 'reviewer', ''))) not between 2 and 100
        or review_record ->> 'reviewer'
          <> btrim(coalesce(review_record ->> 'reviewer', ''))
        or btrim(coalesce(review_record ->> 'reviewer', '')) ~ '[[:cntrl:]]'
        or length(
          btrim(coalesce(review_record ->> 'evidenceReference', ''))
        ) not between 5 and 240
        or review_record ->> 'evidenceReference'
          <> btrim(coalesce(review_record ->> 'evidenceReference', ''))
        or btrim(
          coalesce(review_record ->> 'evidenceReference', '')
        ) ~ '[[:cntrl:]]'
        or coalesce(review_record ->> 'reviewedAt', '') !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$';
      reviewed_at_value := null;
      if not review_invalid then
        begin
          reviewed_at_value := (review_record ->> 'reviewedAt')::timestamptz;
        exception
          when data_exception then
            review_invalid := true;
        end;
      end if;
      if reviewed_at_value is null
        or reviewed_at_value < timestamptz '2000-01-01 00:00:00+00'
        or reviewed_at_value > now()
      then
        review_invalid := true;
      end if;
      if review_invalid then
        issues := issues || jsonb_build_array(jsonb_build_object(
          'section', review_section,
          'code', 'approved_review_evidence_invalid',
          'message', review_label || ' approval requires an exact reviewer, non-future timestamp, and evidence reference.',
          'severity', 'blocking'
        ));
      end if;
    end if;
  end loop;
  if p_publication_mode = 'live' then
    if p_configuration #>> '{pricing,taxReview,status}' <> 'approved' then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'section', 'pricing',
        'code', 'tax_review_required',
        'message', 'Approved tax review evidence is required for live publication.',
        'severity', 'blocking'
      ));
    end if;
    if p_configuration #>> '{policies,legalReview,status}' <> 'approved'
      or p_configuration #>> '{policies,privacyReview,status}' <> 'approved'
      or p_configuration #>> '{policies,safetyReview,status}' <> 'approved'
      or p_configuration #>> '{policies,insuranceReview,status}' <> 'approved'
      or p_configuration #>> '{policies,environmentalReview,status}' <> 'approved'
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'section', 'policies',
        'code', 'qualified_reviews_required',
        'message', 'Legal, privacy, safety, insurance, and environmental review evidence is required for live publication.',
        'severity', 'blocking'
      ));
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_configuration #> '{materials,catalog}') material
      where coalesce((material ->> 'requiresSds')::boolean, false)
        and material ->> 'sdsStatus' <> 'approved'
    ) then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'section', 'materials',
        'code', 'sds_review_required',
        'message', 'Every chemical material requires approved SDS evidence.',
        'severity', 'blocking'
      ));
    end if;
    if exists (
      select 1
      from jsonb_array_elements_text(
        p_configuration #> '{pricing,enabledServiceCodes}'
      ) service_code
      where service_code in ('soft-wash-house', 'roof-washing')
    )
      and not exists (
        select 1
        from jsonb_array_elements(p_configuration #> '{materials,catalog}') material
        where coalesce((material ->> 'requiresSds')::boolean, false)
      )
    then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'section', 'materials',
        'code', 'chemical_material_missing',
        'message', 'Enabled soft-wash services require a configured chemical material and SDS record.',
        'severity', 'blocking'
      ));
    end if;
  end if;
  return issues;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return issues || jsonb_build_array(jsonb_build_object(
      'section', 'identity',
      'code', 'typed_value_invalid',
      'message', 'A typed boolean or numeric configuration value is invalid.',
      'severity', 'blocking'
    ));
end;
$$;

create or replace function public.save_company_configuration_draft(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_revision integer,
  p_configuration jsonb,
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
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  current_draft public.company_configuration_versions%rowtype;
  current_revision integer;
  next_revision integer;
  computed_configuration_hash text;
  validation_issues jsonb;
  result jsonb;
begin
  if actor_user_id is null then
    raise exception 'Authentication is required';
  end if;
  if p_command_id is null or p_expected_revision < 0 then
    raise exception 'Stable command ID and non-negative expected revision are required';
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
    raise exception 'Only an active company owner can save configuration drafts';
  end if;

  effective_request_hash := encode(extensions.digest(jsonb_build_object(
    'expectedRevision', p_expected_revision,
    'configuration', p_configuration
  )::text, 'sha256'), 'hex');
  computed_configuration_hash := encode(
    extensions.digest(p_configuration::text, 'sha256'),
    'hex'
  );
  validation_issues := public.validate_company_configuration(
    p_company_id,
    p_configuration,
    'sandbox'
  );
  if exists (
    select 1 from jsonb_array_elements(validation_issues) issue
    where issue ->> 'severity' = 'blocking'
      and issue ->> 'code' = any(array[
        'publication_mode_invalid',
        'schema_invalid',
        'section_missing',
        'secret_material_rejected',
        'services_missing',
        'service_not_provisioned',
        'service_rules_missing',
        'enabled_service_rule_missing',
        'package_tiers_incomplete',
        'package_service_not_enabled',
        'package_add_on_unresolved',
        'business_hours_incomplete',
        'travel_zones_missing',
        'travel_zone_codes_invalid',
        'travel_zone_postal_mappings_missing',
        'travel_zone_postal_mapping_invalid',
        'travel_zone_postal_mapping_duplicate',
        'travel_zone_mapping_review_missing',
        'active_owner_required',
        'provider_matrix_missing',
        'provider_matrix_incomplete',
        'typed_value_invalid'
      ]::text[])
  ) then
    raise exception 'Configuration draft failed structural server validation: %',
      validation_issues;
  end if;

  insert into public.idempotency_keys(company_id, scope, key, request_hash, expires_at)
  values (
    p_company_id,
    'company-configuration-save-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '365 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select * into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'company-configuration-save-v1'
      and key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'Configuration command ID was reused with a different payload';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'The same configuration command is already in progress';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-company-configuration:' || p_company_id::text,
    0
  ));
  select * into current_draft
  from public.company_configuration_versions record
  where record.company_id = p_company_id and record.status = 'draft'
  for update;
  select coalesce(max(record.revision), 0)
  into current_revision
  from public.company_configuration_versions record
  where record.company_id = p_company_id;
  if current_revision <> p_expected_revision then
    raise exception 'Configuration draft revision changed; reload before saving';
  end if;
  next_revision := current_revision + 1;
  if current_draft.id is not null then
    update public.company_configuration_versions
    set status = 'superseded', updated_at = now()
    where id = current_draft.id;
  end if;
  insert into public.company_configuration_versions(
    company_id, revision, schema_version, status, configuration,
    configuration_hash, created_by
  )
  values (
    p_company_id, next_revision, 'storyops-company-config-v1', 'draft',
    p_configuration, computed_configuration_hash, actor_user_id
  );

  result := jsonb_build_object(
    'schemaVersion', 'storyops-company-config-receipt-v1',
    'commandType', 'company.configuration.save',
    'status', 'draft',
    'companyId', p_company_id,
    'revision', next_revision,
    'configurationHash', computed_configuration_hash,
    'issues', validation_issues,
    'replayed', false,
    'commandId', p_command_id,
    'serverTime', now()
  );
  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now(), updated_at = now()
  where id = reservation_id;
  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id
  )
  select
    p_company_id, 'user', actor_user_id::text, 'company.configuration_draft_saved',
    'company_configuration', record.id,
    jsonb_build_object(
      'revision', next_revision,
      'configurationHash', computed_configuration_hash,
      'publicationState', 'draft'
    ),
    p_command_id::text
  from public.company_configuration_versions record
  where record.company_id = p_company_id
    and record.revision = next_revision;
  return result;
end;
$$;

create or replace function public.publish_company_configuration(
  p_company_id uuid,
  p_command_id uuid,
  p_expected_revision integer,
  p_publication_mode text,
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
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  draft_record public.company_configuration_versions%rowtype;
  validation_issues jsonb;
  result jsonb;
begin
  if actor_user_id is null then
    raise exception 'Authentication is required';
  end if;
  if p_command_id is null or p_expected_revision < 1 then
    raise exception 'Stable command ID and positive expected revision are required';
  end if;
  if p_publication_mode not in ('sandbox', 'live') then
    raise exception 'Publication mode must be sandbox or live';
  end if;
  if length(btrim(coalesce(p_review_reference, ''))) not between 5 and 240 then
    raise exception 'A review evidence reference is required';
  end if;
  if p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Request hash must be lowercase SHA-256';
  end if;
  select membership.role into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role <> 'owner' then
    raise exception 'Only an active company owner can publish configuration';
  end if;

  effective_request_hash := encode(extensions.digest(jsonb_build_object(
    'expectedRevision', p_expected_revision,
    'publicationMode', p_publication_mode,
    'reviewReference', btrim(p_review_reference)
  )::text, 'sha256'), 'hex');
  insert into public.idempotency_keys(company_id, scope, key, request_hash, expires_at)
  values (
    p_company_id,
    'company-configuration-publish-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '2555 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;
  if reservation_id is null then
    select * into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'company-configuration-publish-v1'
      and key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'Configuration publication command ID was reused with a different payload';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'The same configuration publication is already in progress';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'storyops-company-configuration:' || p_company_id::text,
    0
  ));
  select * into draft_record
  from public.company_configuration_versions record
  where record.company_id = p_company_id
    and record.status = 'draft'
    and record.revision = p_expected_revision
  for update;
  if draft_record.id is null then
    raise exception 'Exact configuration draft revision is unavailable';
  end if;
  validation_issues := public.validate_company_configuration(
    p_company_id,
    draft_record.configuration,
    p_publication_mode
  );
  if exists (
    select 1 from jsonb_array_elements(validation_issues) issue
    where issue ->> 'severity' = 'blocking'
  ) then
    raise exception 'Configuration publication blocked by validation: %', validation_issues;
  end if;

  update public.company_configuration_versions
  set status = 'retired', updated_at = now()
  where company_id = p_company_id and status = 'published';
  update public.company_configuration_versions
  set
    status = 'published',
    publication_mode = p_publication_mode,
    review_reference = btrim(p_review_reference),
    published_by = actor_user_id,
    published_at = now(),
    updated_at = now()
  where id = draft_record.id;
  update public.companies
  set settings = settings || jsonb_build_object(
    'configurationPublishedRevision', p_expected_revision,
    'configurationPublicationMode', p_publication_mode,
    'configurationHash', draft_record.configuration_hash
  ),
  updated_at = now()
  where id = p_company_id;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-company-config-receipt-v1',
    'commandType', 'company.configuration.publish',
    'status', 'published',
    'companyId', p_company_id,
    'revision', p_expected_revision,
    'publicationMode', p_publication_mode,
    'configurationHash', draft_record.configuration_hash,
    'reviewReference', btrim(p_review_reference),
    'issues', validation_issues,
    'replayed', false,
    'commandId', p_command_id,
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
    p_company_id, 'user', actor_user_id::text, 'company.configuration_published',
    'company_configuration', draft_record.id,
    jsonb_build_object(
      'revision', p_expected_revision,
      'publicationMode', p_publication_mode,
      'configurationHash', draft_record.configuration_hash,
      'reviewReference', btrim(p_review_reference),
      'launchAuthorized', false,
      'providersActivated', false
    ),
    p_command_id::text
  );
  return result;
end;
$$;

create or replace function public.get_company_configuration_state(
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
  draft_record public.company_configuration_versions%rowtype;
  published_record public.company_configuration_versions%rowtype;
begin
  if actor_user_id is null then
    raise exception 'Authentication is required';
  end if;
  select membership.role into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role <> 'owner' then
    raise exception 'Only an active company owner can read configuration state';
  end if;
  select * into draft_record
  from public.company_configuration_versions record
  where record.company_id = p_company_id and record.status = 'draft';
  select * into published_record
  from public.company_configuration_versions record
  where record.company_id = p_company_id and record.status = 'published';
  if draft_record.id is null and published_record.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'schemaVersion', 'storyops-company-config-record-v1',
    'status', case
      when draft_record.id is not null then 'draft'
      else 'published'
    end,
    'revision', coalesce(draft_record.revision, published_record.revision),
    'draft', coalesce(draft_record.configuration, published_record.configuration),
    'published', published_record.configuration,
    'updatedAt', coalesce(draft_record.updated_at, published_record.updated_at),
    'publishedAt', published_record.published_at,
    'publicationMode', published_record.publication_mode,
    'publicationReceipt', case
      when published_record.id is null then null
      else jsonb_build_object(
        'commandId', (
          select audit.request_id::uuid
          from public.audit_events audit
          where audit.company_id = p_company_id
            and audit.entity_type = 'company_configuration'
            and audit.entity_id = published_record.id
            and audit.action = 'company.configuration_published'
          order by audit.occurred_at desc
          limit 1
        ),
        'configurationHash', published_record.configuration_hash,
        'reviewReference', published_record.review_reference,
        'replayed', false
      )
    end
  );
end;
$$;

alter table public.company_configuration_versions enable row level security;

create policy company_configuration_owner_select
on public.company_configuration_versions for select
using (public.has_company_role(company_id, array['owner']::public.app_role[]));

revoke all on table public.company_configuration_versions from public, anon, authenticated;
grant select on table public.company_configuration_versions to authenticated;

revoke all on function public.guard_published_company_configuration()
  from public, anon, authenticated;
revoke all on function public.validate_company_configuration(uuid, jsonb, text)
  from public, anon;
grant execute on function public.validate_company_configuration(uuid, jsonb, text)
  to authenticated;
revoke all on function public.save_company_configuration_draft(
  uuid, uuid, integer, jsonb, text
) from public, anon;
grant execute on function public.save_company_configuration_draft(
  uuid, uuid, integer, jsonb, text
) to authenticated;
revoke all on function public.publish_company_configuration(
  uuid, uuid, integer, text, text, text
) from public, anon;
grant execute on function public.publish_company_configuration(
  uuid, uuid, integer, text, text, text
) to authenticated;
revoke all on function public.get_company_configuration_state(uuid)
  from public, anon;
grant execute on function public.get_company_configuration_state(uuid)
  to authenticated;

comment on table public.company_configuration_versions is
  'Immutable published owner-configuration snapshots plus one finite-command-managed draft.';
comment on function public.save_company_configuration_draft(
  uuid, uuid, integer, jsonb, text
) is
  'Idempotently saves a validated owner configuration draft without enabling launch or providers.';
comment on function public.publish_company_configuration(
  uuid, uuid, integer, text, text, text
) is
  'Publishes an exact reviewed configuration revision; does not publish pricing/terms or authorize launch.';
