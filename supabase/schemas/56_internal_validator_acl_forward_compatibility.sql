-- Restore the internal-validator ACL after provider-authority wrapping.
-- Browser callers use finite configuration mutation/projection RPCs; the
-- validator itself remains callable only from trusted security-definer code.

revoke all on function public.validate_company_configuration(uuid, jsonb, text)
  from public, anon, authenticated, service_role;

comment on function public.validate_company_configuration(uuid, jsonb, text) is
  'Private configuration validator. Finite owner/dispatcher RPCs invoke it behind tenant, role, version, and publication-policy boundaries.';
