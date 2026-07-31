-- Immediate offboarding applies to customer-visible service packages as well as
-- portal RPCs and media. Configuration validation remains an internal
-- owner-command implementation detail and must not be callable as a catalog
-- discovery oracle by arbitrary authenticated users.

drop policy if exists service_packages_company_read
on public.service_packages;

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
      and public.is_customer_user(portal.company_id, portal.customer_id)
  )
);

drop policy if exists service_package_components_company_read
on public.service_package_components;

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
      and public.is_customer_user(portal.company_id, portal.customer_id)
  )
);

revoke execute on function public.validate_company_configuration(uuid, jsonb, text)
from authenticated;
