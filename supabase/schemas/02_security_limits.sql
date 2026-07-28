-- Durable, service-role-only fixed-window budgets for provider and AI boundaries.
create table public.operation_budget_windows (
  company_id uuid not null references public.companies(id) on delete cascade,
  scope text not null check (length(scope) between 1 and 100),
  subject_hash text not null check (subject_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz not null,
  window_seconds integer not null check (window_seconds between 1 and 604800),
  units_used bigint not null check (units_used > 0),
  updated_at timestamptz not null default now(),
  primary key (company_id, scope, subject_hash, window_start, window_seconds)
);

alter table public.operation_budget_windows enable row level security;

create index operation_budget_windows_cleanup_idx
  on public.operation_budget_windows(window_start);

create or replace function public.consume_operation_budget(
  p_company_id uuid,
  p_scope text,
  p_subject_hash text,
  p_limit bigint,
  p_window_seconds integer,
  p_units bigint default 1
)
returns table(
  allowed boolean,
  used bigint,
  remaining bigint,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_window timestamptz;
  current_used bigint;
begin
  if auth.role() <> 'service_role' and current_user <> 'postgres' then
    raise exception 'Operation budgets are service-role controlled';
  end if;
  if p_scope is null or length(p_scope) not between 1 and 100 then
    raise exception 'Operation budget scope is invalid';
  end if;
  if p_subject_hash is null or p_subject_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Operation budget subject hash is invalid';
  end if;
  if p_limit <= 0 or p_units <= 0 or p_window_seconds not between 1 and 604800 then
    raise exception 'Operation budget limits are invalid';
  end if;

  current_window := to_timestamp(
    floor(extract(epoch from statement_timestamp()) / p_window_seconds)
      * p_window_seconds
  );

  insert into public.operation_budget_windows(
    company_id, scope, subject_hash, window_start, window_seconds, units_used
  )
  values (
    p_company_id, p_scope, p_subject_hash, current_window, p_window_seconds, p_units
  )
  on conflict (company_id, scope, subject_hash, window_start, window_seconds)
  do update set
    units_used = public.operation_budget_windows.units_used + excluded.units_used,
    updated_at = now()
  returning units_used into current_used;

  delete from public.operation_budget_windows
  where company_id = p_company_id
    and window_start < now() - interval '8 days';

  return query
  select
    current_used <= p_limit,
    current_used,
    greatest(0::bigint, p_limit - current_used),
    current_window + make_interval(secs => p_window_seconds);
end;
$$;

revoke all on table public.operation_budget_windows from public, anon, authenticated;
revoke all on function public.consume_operation_budget(
  uuid, text, text, bigint, integer, bigint
) from public, anon, authenticated;
grant execute on function public.consume_operation_budget(
  uuid, text, text, bigint, integer, bigint
) to service_role;
