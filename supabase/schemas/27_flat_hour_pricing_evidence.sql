-- Migration 07 originally persisted only area, length, and count pricing units.
-- Upgrade that exact predecessor definition in place for already-migrated
-- installations. Fresh installs already receive the expanded source definition
-- from migration 07, so this migration is intentionally idempotent there.

do $upgrade$
declare
  function_signature regprocedure :=
    'public.persist_priced_estimate(uuid,uuid,text,text,text,jsonb,uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text)'::regprocedure;
  function_definition text;
  old_unit_list text := 'not in (''sq_ft'', ''linear_ft'', ''each'')';
  old_add_on_catalog_union text :=
    'union
    select distinct add_on ->> ''code''
    from jsonb_array_elements(p_calculation_input -> ''services'') service,
      jsonb_array_elements(coalesce(service -> ''addOns'', ''[]''::jsonb)) add_on';
  old_service_branch text :=
    'or (service_value ->> ''pricingUnit'' = ''each''
              and measurement.kind = ''count''
              and measurement.unit = ''each'')';
  new_service_branch text :=
    'or (service_value ->> ''pricingUnit'' = ''each''
              and measurement.kind = ''count''
              and measurement.unit = ''each'')
            or (service_value ->> ''pricingUnit'' = ''flat''
              and measurement.kind = ''count''
              and measurement.unit = ''each''
              and measurement.value = 1)
            or (service_value ->> ''pricingUnit'' = ''hour''
              and measurement.kind = ''duration_hours''
              and measurement.unit = ''hour'')';
  old_add_on_branch text :=
    'or (add_on_value ->> ''pricingUnit'' = ''each''
                and measurement.kind = ''count''
                and measurement.unit = ''each'')';
  new_add_on_branch text :=
    'or (add_on_value ->> ''pricingUnit'' = ''each''
                and measurement.kind = ''count''
                and measurement.unit = ''each'')
              or (add_on_value ->> ''pricingUnit'' = ''flat''
                and measurement.kind = ''count''
                and measurement.unit = ''each''
                and measurement.value = 1)
              or (add_on_value ->> ''pricingUnit'' = ''hour''
                and measurement.kind = ''duration_hours''
                and measurement.unit = ''hour'')';
begin
  select pg_get_functiondef(function_signature)
  into function_definition;

  if position('service_value ->> ''pricingUnit'' = ''hour''' in function_definition) > 0
    and position('add_on_value ->> ''pricingUnit'' = ''hour''' in function_definition) > 0
    and position('''flat'', ''sq_ft'', ''linear_ft'', ''each'', ''hour''' in function_definition) > 0
    and position(old_add_on_catalog_union in function_definition) = 0
  then
    return;
  end if;

  if (
    length(function_definition) - length(replace(function_definition, old_unit_list, ''))
  ) / length(old_unit_list) <> 2
    or position(old_service_branch in function_definition) = 0
    or position(old_add_on_branch in function_definition) = 0
    or position(old_add_on_catalog_union in function_definition) = 0
  then
    raise exception
      'Unexpected persist_priced_estimate predecessor; refusing an unsafe pricing-evidence upgrade';
  end if;

  function_definition := replace(
    function_definition,
    old_unit_list,
    'not in (''flat'', ''sq_ft'', ''linear_ft'', ''each'', ''hour'')'
  );
  function_definition := replace(
    function_definition,
    old_service_branch,
    new_service_branch
  );
  function_definition := replace(
    function_definition,
    old_add_on_branch,
    new_add_on_branch
  );
  function_definition := replace(
    function_definition,
    old_add_on_catalog_union,
    ''
  );
  execute function_definition;
end;
$upgrade$;
