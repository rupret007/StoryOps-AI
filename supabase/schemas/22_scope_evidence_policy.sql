-- Industry-pack-owned scope evidence policy.
--
-- Exterior cleaning remains photo-required. Other reviewed industry packs may
-- explicitly make photos optional or not applicable without bypassing current,
-- human-verified measurements or their own human-review triggers.

alter table public.service_catalog
  add column scope_evidence_policy text not null default 'photo_required'
  check (scope_evidence_policy in ('photo_required', 'photo_optional', 'not_applicable'));

comment on column public.service_catalog.scope_evidence_policy is
  'Versioned industry-pack policy for estimate scope photos. Deterministic measurements remain mandatory for every mode.';

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

  expected_disposition := case
    when has_required_policy and latest_photo_disposition = 'usable_for_scope'
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

  if expected_disposition = 'usable_for_scope'
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

drop trigger if exists estimates_scope_evidence_policy on public.estimates;
create trigger estimates_scope_evidence_policy
  before insert or update of status, calculation_input, evidence_analysis_ids
  on public.estimates
  for each row execute function public.enforce_estimate_scope_evidence_policy();

revoke all on function public.enforce_estimate_scope_evidence_policy()
  from public, anon, authenticated;

