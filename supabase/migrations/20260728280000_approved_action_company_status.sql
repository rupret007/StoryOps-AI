-- Upgrade defense for installations that already applied the original
-- approved-action functions. Fresh installs also enforce active company status
-- inside both RPCs. These triggers prevent old functions from beginning a
-- provider mutation or atomically consuming a lead approval while paused.

create or replace function public.enforce_active_company_approved_action_start()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1
    from public.companies company
    where company.id = new.company_id
      and company.status = 'active'
  ) then
    raise exception using message = 'APPROVED_ACTION_OWNER_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger approved_action_executions_active_company
before insert on public.approved_action_executions
for each row execute function public.enforce_active_company_approved_action_start();

create or replace function public.enforce_active_company_lead_approval_consumption()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if old.consumed_at is null
    and new.consumed_at is not null
    and new.action_type in ('records.create_lead', 'records.update_lead')
    and not exists (
      select 1
      from public.companies company
      where company.id = new.company_id
        and company.status = 'active'
    )
  then
    raise exception using message = 'APPROVED_LEAD_OWNER_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger approval_requests_active_company_lead_consumption
before update of consumed_at on public.approval_requests
for each row execute function public.enforce_active_company_lead_approval_consumption();

revoke all on function public.enforce_active_company_approved_action_start()
from public, anon, authenticated, service_role;
revoke all on function public.enforce_active_company_lead_approval_consumption()
from public, anon, authenticated, service_role;
