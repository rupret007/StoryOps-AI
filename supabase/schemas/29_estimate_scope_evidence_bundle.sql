-- Bind estimate approval to one complete, human-reviewed scope-photo request.
--
-- A globally "usable" photo analysis remains useful context, but it is not
-- authorization for a photo-required service. The newest exact
-- company/customer/property request, its latest review, every required view,
-- and every priced measurement must form one immutable bundle.

create or replace function public.exterior_scope_checklist_v2()
returns jsonb
language sql
immutable
set search_path = pg_catalog, public
as $$
  select jsonb_build_array(
    jsonb_build_object(
      'code', 'front_elevation',
      'label', 'Front elevation',
      'guidance', 'Show the full front elevation, work boundaries, and approach path.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 10
    ),
    jsonb_build_object(
      'code', 'rear_elevation',
      'label', 'Rear elevation',
      'guidance', 'Show the full rear elevation, gates, doors, and nearby obstacles.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 20
    ),
    jsonb_build_object(
      'code', 'left_elevation',
      'label', 'Left elevation',
      'guidance', 'Show the full left elevation and technician access path.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 30
    ),
    jsonb_build_object(
      'code', 'right_elevation',
      'label', 'Right elevation',
      'guidance', 'Show the full right elevation and technician access path.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 40
    ),
    jsonb_build_object(
      'code', 'flatwork_boundary',
      'label', 'Flatwork boundary',
      'guidance', 'Show driveway, walk, patio, or other flatwork edges and adjacent surfaces.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 50
    ),
    jsonb_build_object(
      'code', 'surface_growth_detail',
      'label', 'Surface and growth detail',
      'guidance', 'Show siding or surface material plus staining, organic growth, oxidation, or damage.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 60
    ),
    jsonb_build_object(
      'code', 'roof_planes_rooflines',
      'label', 'Roof planes and rooflines',
      'guidance', 'From the ground, show visible roof planes, valleys, eaves, and roofline transitions.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 70
    ),
    jsonb_build_object(
      'code', 'roof_material_pitch_growth',
      'label', 'Roof material, pitch, and growth',
      'guidance', 'From a safe ground position, show roof material, apparent pitch, and visible growth.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 80
    ),
    jsonb_build_object(
      'code', 'gutter_debris_guards',
      'label', 'Gutter debris and guards',
      'guidance', 'Show representative gutter condition, visible debris, seams, and any gutter guards.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 90
    ),
    jsonb_build_object(
      'code', 'downspout_runoff',
      'label', 'Downspouts and runoff',
      'guidance', 'Show downspout count and termination, drainage path, and runoff-sensitive areas.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 100
    ),
    jsonb_build_object(
      'code', 'window_configuration',
      'label', 'Window configuration',
      'guidance', 'Show representative windows, screens, tracks, frames, and nearby delicate finishes.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 110
    ),
    jsonb_build_object(
      'code', 'access_drainage_risk',
      'label', 'Access, drainage, and risk detail',
      'guidance', 'Show gates, stairs, slopes, ladder footing, utilities, plants, drainage, and fragile items.',
      'required', true,
      'maximumPhotos', 1,
      'sortOrder', 120
    )
  );
$$;

revoke all on function public.exterior_scope_checklist_v2()
from public, anon, authenticated, service_role;

-- Upgrade the trusted request command without duplicating its idempotency and
-- actor-bound implementation. The command and estimate trigger take the same
-- property FOR UPDATE lock, closing the race where a newer request could be
-- inserted immediately after an older reviewed request was authorized.
do $upgrade_scope_request$
declare
  function_signature regprocedure :=
    'public.create_scope_photo_request(uuid,uuid,uuid,uuid,text,integer,text,text)'::regprocedure;
  function_definition text;
  old_checklist_start integer;
  old_checklist_end integer;
  old_property_check text := '  if not exists (
    select 1
    from public.properties property
    where property.id = p_property_id
      and property.company_id = p_company_id
      and property.customer_id = p_customer_id
  ) then
    raise exception ''SCOPE_PHOTO_PROPERTY_NOT_FOUND'';
  end if;';
  new_property_lock text := '  perform 1
  from public.properties property
  where property.id = p_property_id
    and property.company_id = p_company_id
    and property.customer_id = p_customer_id
  for update;
  if not found then
    raise exception ''SCOPE_PHOTO_PROPERTY_NOT_FOUND'';
  end if;';
begin
  select pg_get_functiondef(function_signature)
  into function_definition;

  if position('checklist_value jsonb := public.exterior_scope_checklist_v2()' in function_definition) = 0 then
    old_checklist_start := position(
      '  checklist_value jsonb := jsonb_build_array(' in function_definition
    );
    old_checklist_end := position(
      E'\nbegin\n' in substring(function_definition from old_checklist_start)
    );
    if old_checklist_start = 0 or old_checklist_end = 0 then
      raise exception
        'Unexpected create_scope_photo_request predecessor; refusing checklist upgrade';
    end if;
    function_definition :=
      substring(function_definition from 1 for old_checklist_start - 1)
      || '  checklist_value jsonb := public.exterior_scope_checklist_v2();'
      || substring(
        function_definition
        from old_checklist_start + old_checklist_end - 1
      );
  end if;

  if position(new_property_lock in function_definition) = 0 then
    if position(old_property_check in function_definition) = 0 then
      raise exception
        'Unexpected create_scope_photo_request predecessor; refusing lock upgrade';
    end if;
    function_definition := replace(
      function_definition,
      old_property_check,
      new_property_lock
    );
  end if;

  function_definition := replace(
    function_definition,
    '''exterior-scope-v1''',
    '''exterior-scope-v2'''
  );
  execute function_definition;
end;
$upgrade_scope_request$;

-- Inactive requests cannot be revived by appending a measurement or review.
do $upgrade_inactive_scope_commands$
declare
  function_signature regprocedure;
  function_definition text;
  insertion_marker text;
  inactive_guard text := '  if request_row.status in (''expired'', ''cancelled'')
    or request_row.expires_at <= now()
  then
    raise exception ''SCOPE_PHOTO_REQUEST_INACTIVE'';
  end if;
';
begin
  function_signature :=
    'public.confirm_scope_photo_measurement(uuid,uuid,uuid,uuid,uuid[],text,text,numeric,text,text[],text[],text,text,text)'::regprocedure;
  select pg_get_functiondef(function_signature) into function_definition;
  if position('SCOPE_PHOTO_REQUEST_INACTIVE' in function_definition) = 0 then
    insertion_marker := '  expected_unit := case p_kind';
    if position(insertion_marker in function_definition) = 0 then
      raise exception
        'Unexpected confirm_scope_photo_measurement predecessor; refusing inactive-request upgrade';
    end if;
    function_definition := replace(
      function_definition,
      insertion_marker,
      inactive_guard || insertion_marker
    );
    execute function_definition;
  end if;

  function_signature :=
    'public.review_scope_photo_request(uuid,uuid,uuid,text,text,text,text[],text,text)'::regprocedure;
  select pg_get_functiondef(function_signature) into function_definition;
  if position('SCOPE_PHOTO_REQUEST_INACTIVE' in function_definition) = 0 then
    insertion_marker := '  if p_disposition not in (';
    if position(insertion_marker in function_definition) = 0 then
      raise exception
        'Unexpected review_scope_photo_request predecessor; refusing inactive-request upgrade';
    end if;
    function_definition := replace(
      function_definition,
      insertion_marker,
      inactive_guard || insertion_marker
    );
    execute function_definition;
  end if;
end;
$upgrade_inactive_scope_commands$;

-- Existing installations already own the long deterministic persistence
-- function. Add one narrow snapshot equality assertion in place; fresh
-- installations already receive it from migration 07.
do $upgrade_estimate_snapshot_binding$
declare
  function_signature regprocedure :=
    'public.persist_priced_estimate(uuid,uuid,text,text,text,jsonb,uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb,text,text)'::regprocedure;
  function_definition text;
  insertion_marker text :=
    '  if p_authoritative_snapshot -> ''photoEvidence'' = ''null''::jsonb then';
  snapshot_guard text := '  if p_authoritative_snapshot -> ''scopeEvidenceBundle''
    is distinct from p_calculation_input -> ''scopeEvidenceBundle''
  then
    raise exception ''ESTIMATE_SCOPE_EVIDENCE_SNAPSHOT_MISMATCH'';
  end if;
';
begin
  select pg_get_functiondef(function_signature)
  into function_definition;
  if position('ESTIMATE_SCOPE_EVIDENCE_SNAPSHOT_MISMATCH' in function_definition) = 0 then
    if position(insertion_marker in function_definition) = 0 then
      raise exception
        'Unexpected persist_priced_estimate predecessor; refusing scope-bundle snapshot upgrade';
    end if;
    function_definition := replace(
      function_definition,
      insertion_marker,
      snapshot_guard || insertion_marker
    );
    execute function_definition;
  end if;
end;
$upgrade_estimate_snapshot_binding$;

alter table public.estimates
  add column scope_photo_request_id uuid
    references public.scope_photo_requests(id) on delete restrict,
  add column scope_photo_review_id uuid
    references public.scope_photo_reviews(id) on delete restrict,
  add column scope_photo_checklist_version text,
  add constraint estimates_scope_photo_bundle_all_or_none check (
    (
      scope_photo_request_id is null
      and scope_photo_review_id is null
      and scope_photo_checklist_version is null
    )
    or (
      scope_photo_request_id is not null
      and scope_photo_review_id is not null
      and nullif(btrim(scope_photo_checklist_version), '') is not null
    )
  );

create index estimates_scope_photo_request_idx
  on public.estimates(company_id, scope_photo_request_id)
  where scope_photo_request_id is not null;

comment on column public.estimates.scope_photo_request_id is
  'Newest exact customer/property scope-photo request atomically authorized for this estimate.';
comment on column public.estimates.scope_photo_review_id is
  'Latest confirmed human review atomically authorized for this estimate.';
comment on column public.estimates.scope_photo_checklist_version is
  'Supported server-authored checklist version bound with the estimate evidence snapshot.';

create or replace function public.build_estimate_scope_evidence_bundle(
  p_company_id uuid,
  p_customer_id uuid,
  p_property_id uuid,
  p_measurement_ids uuid[]
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = pg_catalog, public
as $$
declare
  request_row public.scope_photo_requests%rowtype;
  review_row public.scope_photo_reviews%rowtype;
  has_review boolean := false;
  expected_checklist_codes text[];
  checklist_codes text[] := array[]::text[];
  required_checklist_codes text[] := array[]::text[];
  submitted_checklist_codes text[] := array[]::text[];
  normalized_measurement_ids uuid[];
  linked_analysis_ids uuid[] := array[]::uuid[];
  confirmed_measurement_count integer := 0;
  eligible_value boolean := false;
  reason_value text := 'request_missing';
begin
  if p_company_id is null
    or p_customer_id is null
    or p_property_id is null
    or coalesce(cardinality(p_measurement_ids), 0) not between 1 and 50
    or cardinality(p_measurement_ids) <> (
      select count(distinct measurement_id)
      from unnest(p_measurement_ids) measurement_id
    )
    or array_position(p_measurement_ids, null) is not null
  then
    raise exception 'ESTIMATE_SCOPE_BUNDLE_MEASUREMENTS_INVALID';
  end if;

  select array_agg(measurement_id order by measurement_id)
  into normalized_measurement_ids
  from unnest(p_measurement_ids) measurement_id;

  select array_agg(item ->> 'code' order by item ->> 'code')
  into expected_checklist_codes
  from jsonb_array_elements(public.exterior_scope_checklist_v2()) item;

  select request.*
  into request_row
  from public.scope_photo_requests request
  where request.company_id = p_company_id
    and request.customer_id = p_customer_id
    and request.property_id = p_property_id
  order by request.created_at desc, request.id desc
  limit 1;

  if found then
    select coalesce(array_agg(item ->> 'code' order by item ->> 'code'), '{}'::text[])
    into checklist_codes
    from jsonb_array_elements(request_row.checklist) item;

    select coalesce(array_agg(item ->> 'code' order by item ->> 'code'), '{}'::text[])
    into required_checklist_codes
    from jsonb_array_elements(request_row.checklist) item
    where coalesce((item ->> 'required')::boolean, false);

    select review.*
    into review_row
    from public.scope_photo_reviews review
    where review.company_id = p_company_id
      and review.request_id = request_row.id
    order by review.reviewed_at desc, review.id desc
    limit 1;
    has_review := found;

    select coalesce(array_agg(code order by code), '{}'::text[])
    into submitted_checklist_codes
    from (
      select distinct submission.checklist_item_code as code
      from public.scope_photo_submissions submission
      where submission.company_id = p_company_id
        and submission.request_id = request_row.id
        and (
          not has_review
          or submission.created_at <= review_row.reviewed_at
        )
    ) submitted;

    if has_review then
      select count(*)
      into confirmed_measurement_count
      from unnest(normalized_measurement_ids) requested(measurement_id)
      where exists (
        select 1
        from public.scope_confirmed_measurements confirmation
        join public.property_measurements measurement
          on measurement.id = confirmation.measurement_id
          and measurement.company_id = confirmation.company_id
        where confirmation.company_id = p_company_id
          and confirmation.request_id = request_row.id
          and confirmation.measurement_id = requested.measurement_id
          and confirmation.confirmed_at <= review_row.reviewed_at
          and measurement.property_id = p_property_id
          and measurement.verified_by_human
          and not exists (
            select 1
            from public.property_measurements replacement
            where replacement.company_id = measurement.company_id
              and replacement.property_id = measurement.property_id
              and replacement.supersedes_measurement_id = measurement.id
          )
      );
    end if;

    select coalesce(array_agg(analysis_id order by analysis_id), '{}'::uuid[])
    into linked_analysis_ids
    from (
      select distinct submission.analysis_id
      from public.scope_photo_submissions submission
      join public.photo_analyses analysis
        on analysis.id = submission.analysis_id
        and analysis.company_id = submission.company_id
        and analysis.property_id = p_property_id
        and analysis.purpose = 'scope'
      where submission.company_id = p_company_id
        and submission.request_id = request_row.id
        and submission.analysis_id is not null
        and (
          not has_review
          or submission.created_at <= review_row.reviewed_at
        )
    ) linked;

    if request_row.status <> 'reviewed'
      or request_row.expires_at <= now()
    then
      reason_value := 'request_inactive_or_incomplete';
    elsif request_row.checklist_version <> 'exterior-scope-v2'
      or checklist_codes is distinct from expected_checklist_codes
      or required_checklist_codes is distinct from expected_checklist_codes
    then
      reason_value := 'unsupported_checklist';
    elsif not has_review
      or review_row.disposition <> 'confirmed_for_estimate'
    then
      reason_value := 'confirmed_review_required';
    elsif coalesce(cardinality(review_row.unresolved_unknowns), 0) > 0 then
      reason_value := 'unresolved_unknowns';
    elsif not required_checklist_codes <@ submitted_checklist_codes then
      reason_value := 'required_views_incomplete';
    elsif confirmed_measurement_count <> cardinality(normalized_measurement_ids) then
      reason_value := 'measurement_evidence_incomplete';
    else
      eligible_value := true;
      reason_value := null;
    end if;
  end if;

  return jsonb_build_object(
    'schemaVersion', 'storyops-estimate-scope-evidence-v1',
    'eligible', eligible_value,
    'reason', reason_value,
    'requestId', case when request_row.id is null then null else to_jsonb(request_row.id) end,
    'requestVersion', request_row.version,
    'requestStatus', request_row.status,
    'reviewId', case when not has_review then null else to_jsonb(review_row.id) end,
    'reviewedAt', case when not has_review then null else to_jsonb(review_row.reviewed_at) end,
    'reviewDisposition', case when not has_review then null else review_row.disposition end,
    'checklistVersion', request_row.checklist_version,
    'checklistCodes', to_jsonb(checklist_codes),
    'requiredChecklistCodes', to_jsonb(required_checklist_codes),
    'submittedChecklistCodes', to_jsonb(submitted_checklist_codes),
    'measurementIds', to_jsonb(normalized_measurement_ids),
    'analysisIds', to_jsonb(linked_analysis_ids),
    'unresolvedUnknowns', case
      when not has_review then '[]'::jsonb
      else to_jsonb(review_row.unresolved_unknowns)
    end
  );
end;
$$;

revoke all on function public.build_estimate_scope_evidence_bundle(
  uuid, uuid, uuid, uuid[]
) from public, anon, authenticated, service_role;

create or replace function public.load_estimate_scope_evidence_bundle(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_customer_id uuid,
  p_property_id uuid,
  p_measurement_ids uuid[]
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = pg_catalog, public
as $$
begin
  perform public.resolve_estimate_actor(p_company_id, p_actor_user_id);
  if not exists (
    select 1
    from public.properties property
    where property.id = p_property_id
      and property.company_id = p_company_id
      and property.customer_id = p_customer_id
  ) then
    raise exception 'ESTIMATE_CUSTOMER_PROPERTY_MISMATCH';
  end if;
  return public.build_estimate_scope_evidence_bundle(
    p_company_id,
    p_customer_id,
    p_property_id,
    p_measurement_ids
  );
end;
$$;

revoke all on function public.load_estimate_scope_evidence_bundle(
  uuid, uuid, uuid, uuid, uuid[]
) from public, anon, authenticated;
grant execute on function public.load_estimate_scope_evidence_bundle(
  uuid, uuid, uuid, uuid, uuid[]
) to service_role;

create or replace function public.bind_estimate_scope_evidence_bundle()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  has_required_policy boolean := false;
  required_measurement_ids uuid[] := '{}';
  supplied_bundle jsonb;
  expected_bundle jsonb;
begin
  select exists (
    select 1
    from jsonb_array_elements(coalesce(new.calculation_input -> 'services', '[]'::jsonb)) service
    join public.service_catalog catalog
      on catalog.company_id = new.company_id
      and catalog.code = service ->> 'serviceCode'
      and catalog.active
      and catalog.scope_evidence_policy = 'photo_required'
  )
  into has_required_policy;

  if not has_required_policy then
    if new.calculation_input ? 'scopeEvidenceBundle'
      and new.calculation_input -> 'scopeEvidenceBundle' <> 'null'::jsonb
    then
      raise exception 'ESTIMATE_SCOPE_EVIDENCE_BUNDLE_UNEXPECTED';
    end if;
    new.scope_photo_request_id := null;
    new.scope_photo_review_id := null;
    new.scope_photo_checklist_version := null;
    return new;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(new.calculation_input -> 'services', '[]'::jsonb)) service
    join public.service_catalog catalog
      on catalog.company_id = new.company_id
      and catalog.code = service ->> 'serviceCode'
      and catalog.active
      and catalog.scope_evidence_policy = 'photo_required'
    where coalesce(service ->> 'measurementId', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(service -> 'supportingMeasurementIds', '[]'::jsonb)
        ) supporting(measurement_id)
        where supporting.measurement_id !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      or exists (
        select 1
        from jsonb_array_elements(coalesce(service -> 'addOns', '[]'::jsonb)) add_on
        where coalesce(add_on ->> 'measurementId', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
  ) then
    raise exception 'ESTIMATE_SCOPE_BUNDLE_MEASUREMENTS_INVALID';
  end if;

  select coalesce(array_agg(measurement_id order by measurement_id), '{}'::uuid[])
  into required_measurement_ids
  from (
    select distinct (service ->> 'measurementId')::uuid as measurement_id
    from jsonb_array_elements(new.calculation_input -> 'services') service
    join public.service_catalog catalog
      on catalog.company_id = new.company_id
      and catalog.code = service ->> 'serviceCode'
      and catalog.active
      and catalog.scope_evidence_policy = 'photo_required'
    union
    select distinct supporting.measurement_id::uuid
    from jsonb_array_elements(new.calculation_input -> 'services') service
    join public.service_catalog catalog
      on catalog.company_id = new.company_id
      and catalog.code = service ->> 'serviceCode'
      and catalog.active
      and catalog.scope_evidence_policy = 'photo_required'
    cross join lateral jsonb_array_elements_text(
      coalesce(service -> 'supportingMeasurementIds', '[]'::jsonb)
    ) supporting(measurement_id)
    union
    select distinct (add_on ->> 'measurementId')::uuid
    from jsonb_array_elements(new.calculation_input -> 'services') service
    join public.service_catalog catalog
      on catalog.company_id = new.company_id
      and catalog.code = service ->> 'serviceCode'
      and catalog.active
      and catalog.scope_evidence_policy = 'photo_required'
    cross join lateral jsonb_array_elements(
      coalesce(service -> 'addOns', '[]'::jsonb)
    ) add_on
  ) referenced;

  if cardinality(required_measurement_ids) = 0 then
    raise exception 'ESTIMATE_SCOPE_BUNDLE_MEASUREMENTS_INVALID';
  end if;

  -- Same lock and order as create_scope_photo_request: property first, then
  -- request state. A newer request cannot race this authorization boundary.
  perform 1
  from public.properties property
  where property.id = new.property_id
    and property.company_id = new.company_id
    and property.customer_id = new.customer_id
  for update;
  if not found then
    raise exception 'ESTIMATE_CUSTOMER_PROPERTY_MISMATCH';
  end if;

  expected_bundle := public.build_estimate_scope_evidence_bundle(
    new.company_id,
    new.customer_id,
    new.property_id,
    required_measurement_ids
  );
  supplied_bundle := new.calculation_input -> 'scopeEvidenceBundle';

  if supplied_bundle is null or supplied_bundle = 'null'::jsonb then
    new.scope_photo_request_id := null;
    new.scope_photo_review_id := null;
    new.scope_photo_checklist_version := null;
    if new.status = 'approved' then
      raise exception 'ESTIMATE_SCOPE_PHOTO_REVIEW_REQUIRED';
    end if;
    return new;
  end if;

  if jsonb_typeof(supplied_bundle) <> 'object'
    or supplied_bundle is distinct from expected_bundle
  then
    raise exception 'ESTIMATE_SCOPE_EVIDENCE_BUNDLE_CHANGED';
  end if;

  if coalesce((expected_bundle ->> 'eligible')::boolean, false) then
    new.scope_photo_request_id := (expected_bundle ->> 'requestId')::uuid;
    new.scope_photo_review_id := (expected_bundle ->> 'reviewId')::uuid;
    new.scope_photo_checklist_version := expected_bundle ->> 'checklistVersion';
    select coalesce(array_agg(analysis_id::uuid order by analysis_id::uuid), '{}'::uuid[])
    into new.evidence_analysis_ids
    from jsonb_array_elements_text(expected_bundle -> 'analysisIds') analysis_id;
  else
    new.scope_photo_request_id := null;
    new.scope_photo_review_id := null;
    new.scope_photo_checklist_version := null;
    if new.status = 'approved' then
      raise exception 'ESTIMATE_SCOPE_PHOTO_REVIEW_REQUIRED';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.bind_estimate_scope_evidence_bundle()
from public, anon, authenticated;

drop trigger if exists estimates_scope_evidence_bundle on public.estimates;
create trigger estimates_scope_evidence_bundle
  before insert or update of
    status,
    customer_id,
    property_id,
    calculation_input,
    evidence_analysis_ids,
    scope_photo_request_id,
    scope_photo_review_id,
    scope_photo_checklist_version
  on public.estimates
  for each row execute function public.bind_estimate_scope_evidence_bundle();

-- Replace the v1 global-analysis policy check. Required-photo services now use
-- only the atomically bound request bundle; global latest analysis remains
-- informational. Optional-photo packs keep their existing behavior.
create or replace function public.enforce_estimate_scope_evidence_policy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  requested_service_count integer;
  snapshot_policy_count integer;
  service_code_value text;
  catalog_policy_value text;
  snapshot_policy_value text;
  has_required_policy boolean := false;
  has_optional_policy boolean := false;
  latest_photo_id uuid;
  latest_photo_disposition text;
  expected_disposition text;
  supplied_disposition text;
  bundle_eligible boolean := false;
begin
  if jsonb_typeof(new.calculation_input -> 'services') <> 'array'
    or jsonb_array_length(new.calculation_input -> 'services') not between 1 and 12
    or jsonb_typeof(new.calculation_input -> 'scopeEvidencePolicies') <> 'array'
  then
    raise exception 'ESTIMATE_SCOPE_EVIDENCE_POLICY_INVALID';
  end if;

  select count(*), count(distinct service ->> 'serviceCode')
  into requested_service_count, snapshot_policy_count
  from jsonb_array_elements(new.calculation_input -> 'services') service
  where nullif(btrim(service ->> 'serviceCode'), '') is not null;
  if requested_service_count = 0
    or requested_service_count <> snapshot_policy_count
    or jsonb_array_length(new.calculation_input -> 'scopeEvidencePolicies')
      <> requested_service_count
  then
    raise exception 'ESTIMATE_SCOPE_EVIDENCE_POLICY_SCOPE_MISMATCH';
  end if;

  for service_code_value in
    select service ->> 'serviceCode'
    from jsonb_array_elements(new.calculation_input -> 'services') service
  loop
    select catalog.scope_evidence_policy
    into catalog_policy_value
    from public.service_catalog catalog
    where catalog.company_id = new.company_id
      and catalog.code = service_code_value
      and catalog.active;
    if not found then
      raise exception 'ESTIMATE_SCOPE_EVIDENCE_POLICY_CHANGED';
    end if;

    select count(*), min(policy ->> 'policy')
    into snapshot_policy_count, snapshot_policy_value
    from jsonb_array_elements(new.calculation_input -> 'scopeEvidencePolicies') policy
    where policy ->> 'serviceCode' = service_code_value
      and (policy - array['serviceCode', 'policy']) = '{}'::jsonb;
    if snapshot_policy_count <> 1
      or snapshot_policy_value is distinct from catalog_policy_value
    then
      raise exception 'ESTIMATE_SCOPE_EVIDENCE_POLICY_CHANGED';
    end if;

    has_required_policy :=
      has_required_policy or catalog_policy_value = 'photo_required';
    has_optional_policy :=
      has_optional_policy or catalog_policy_value = 'photo_optional';
  end loop;

  select analysis.id, analysis.disposition
  into latest_photo_id, latest_photo_disposition
  from public.photo_analyses analysis
  where analysis.company_id = new.company_id
    and analysis.property_id = new.property_id
    and analysis.purpose = 'scope'
  order by analysis.analyzed_at desc, analysis.id
  limit 1;

  bundle_eligible :=
    coalesce((new.calculation_input #>> '{scopeEvidenceBundle,eligible}')::boolean, false)
    and new.scope_photo_request_id is not null
    and new.scope_photo_review_id is not null
    and new.scope_photo_checklist_version = 'exterior-scope-v2';

  expected_disposition := case
    when has_required_policy and bundle_eligible
      then 'usable_for_scope'
    when has_required_policy
      then 'human_review_required'
    when has_optional_policy and latest_photo_disposition is null
      then 'not_applicable'
    when has_optional_policy and latest_photo_disposition = 'usable_for_scope'
      then 'usable_for_scope'
    when has_optional_policy
      then 'human_review_required'
    else 'not_applicable'
  end;
  supplied_disposition := new.calculation_input ->> 'scopeEvidenceDisposition';
  if supplied_disposition is distinct from expected_disposition then
    raise exception 'ESTIMATE_SCOPE_EVIDENCE_DISPOSITION_MISMATCH';
  end if;

  if not has_required_policy
    and expected_disposition = 'usable_for_scope'
    and (
      latest_photo_id is null
      or not (latest_photo_id = any(new.evidence_analysis_ids))
    )
  then
    raise exception 'ESTIMATE_SCOPE_PHOTO_EVIDENCE_MISMATCH';
  end if;
  if new.status = 'approved' and expected_disposition = 'human_review_required' then
    raise exception 'ESTIMATE_SCOPE_PHOTO_REVIEW_REQUIRED';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_estimate_scope_evidence_policy()
from public, anon, authenticated;

comment on function public.load_estimate_scope_evidence_bundle(
  uuid, uuid, uuid, uuid, uuid[]
) is
  'Actor-bound, least-privilege estimate evidence projection for the newest exact customer/property scope request.';
comment on function public.bind_estimate_scope_evidence_bundle() is
  'Atomically recomputes and binds a reviewed service-specific photo evidence bundle before estimate approval.';
