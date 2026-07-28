-- Server-controlled mapping from StoryOps customers to provider customer IDs.
create table public.provider_customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  provider text not null check (provider in ('stripe')),
  provider_customer_id text not null check (length(provider_customer_id) between 1 and 255),
  email_snapshot extensions.citext,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, provider, customer_id),
  unique (company_id, provider, provider_customer_id)
);

alter table public.provider_customers enable row level security;

revoke all on table public.provider_customers from public, anon, authenticated;
grant select, insert, update on table public.provider_customers to service_role;

create constraint trigger provider_customers_customer_tenant_integrity
after insert or update on public.provider_customers
deferrable initially immediate
for each row execute function public.assert_same_company_reference('customer_id', 'customers');

create trigger provider_customers_touch
before update on public.provider_customers
for each row execute function public.touch_record();

create trigger provider_customers_audit
after insert or update or delete on public.provider_customers
for each row execute function public.audit_mutation();
