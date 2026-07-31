-- Edge functions use a service-role client, but service_role intentionally has
-- no direct business-table SELECT grants. Expose only the finite, actor-bound
-- catalog policy projection needed by deterministic estimating.

create or replace function public.load_service_scope_evidence_policies(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_catalog_codes text[]
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  requested_count integer;
begin
  perform public.resolve_estimate_actor(p_company_id, p_actor_user_id);

  if coalesce(cardinality(p_catalog_codes), 0) = 0
    or cardinality(p_catalog_codes) > 50
    or cardinality(p_catalog_codes) <> (
      select count(distinct requested_code)
      from unnest(p_catalog_codes) requested_code
    )
    or exists (
      select 1
      from unnest(p_catalog_codes) requested_code
      where requested_code is null
        or requested_code !~ '^[a-z0-9][a-z0-9_-]{0,79}$'
    )
  then
    raise exception 'ESTIMATE_CATALOG_CODES_INVALID';
  end if;

  select count(*)
  into requested_count
  from public.service_catalog catalog
  where catalog.company_id = p_company_id
    and catalog.code = any(p_catalog_codes)
    and catalog.active
    and catalog.scope_evidence_policy in (
      'photo_required',
      'photo_optional',
      'not_applicable'
    );

  if requested_count <> cardinality(p_catalog_codes) then
    raise exception 'ESTIMATE_SERVICE_CATALOG_INVALID';
  end if;

  return (
    select jsonb_agg(
      jsonb_build_object(
        'id', catalog.id,
        'code', catalog.code,
        'version', catalog.version,
        'scope_evidence_policy', catalog.scope_evidence_policy
      )
      order by catalog.code
    )
    from public.service_catalog catalog
    where catalog.company_id = p_company_id
      and catalog.code = any(p_catalog_codes)
      and catalog.active
  );
end;
$$;

revoke all on function public.load_service_scope_evidence_policies(uuid, uuid, text[])
from public, anon, authenticated;
grant execute on function public.load_service_scope_evidence_policies(uuid, uuid, text[])
to service_role;
