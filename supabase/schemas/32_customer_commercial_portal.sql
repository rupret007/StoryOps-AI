-- Customer commercial portal: publication semantics, immutable quote decisions,
-- exact change requests, customer-safe invoice projection, and pending-only
-- invoice-balance checkout reservations.

alter table public.quotes
  add column portal_published_at timestamptz;

update public.quotes
set portal_published_at = coalesce(sent_at, updated_at, created_at)
where status in ('sent', 'viewed', 'accepted', 'declined')
  and portal_published_at is null;

alter table public.quotes
  drop constraint quotes_status_check;

alter table public.quotes
  add constraint quotes_status_check check (
    status in (
      'draft', 'pending_approval', 'sent', 'viewed', 'accepted', 'declined',
      'change_requested', 'expired', 'void'
    )
  ),
  add constraint quotes_portal_publication_evidence check (
    status not in ('sent', 'viewed', 'accepted', 'declined', 'change_requested')
    or portal_published_at is not null
  );

create table public.customer_quote_commands (
  id uuid primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  quote_id uuid not null references public.quotes(id) on delete restrict,
  expected_quote_version integer not null check (expected_quote_version > 0),
  action text not null check (
    action in ('quote.view', 'quote.decline', 'quote.change_request')
  ),
  canonical_request text not null check (
    octet_length(canonical_request) between 2 and 12000
  ),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  unique (company_id, id)
);

create index customer_quote_commands_scope_idx
  on public.customer_quote_commands(company_id, customer_id, quote_id, created_at desc);

create table public.customer_quote_change_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  property_id uuid not null references public.properties(id) on delete restrict,
  quote_id uuid not null references public.quotes(id) on delete restrict,
  quote_version integer not null check (quote_version > 0),
  command_id uuid not null unique
    references public.customer_quote_commands(id) on delete restrict,
  requested_service_codes text[] not null default '{}',
  requested_add_on_codes text[] not null default '{}',
  request_notes text not null default ''
    check (char_length(request_notes) <= 2000),
  quote_snapshot jsonb not null check (jsonb_typeof(quote_snapshot) = 'object'),
  status text not null default 'submitted'
    check (status in ('submitted', 'reviewing', 'resolved', 'cancelled')),
  resolution_disposition text check (
    resolution_disposition is null
    or resolution_disposition in ('replacement_published', 'cancelled')
  ),
  resolution_note text check (
    resolution_note is null or char_length(resolution_note) <= 2000
  ),
  replacement_quote_id uuid references public.quotes(id) on delete restrict,
  replacement_quote_version integer check (
    replacement_quote_version is null or replacement_quote_version > 0
  ),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  constraint customer_quote_change_request_choices check (
    cardinality(requested_service_codes) > 0
    or cardinality(requested_add_on_codes) > 0
    or nullif(btrim(request_notes), '') is not null
  ),
  constraint customer_quote_change_request_resolution check (
    (
      status in ('submitted', 'reviewing')
      and resolved_at is null
      and resolved_by is null
      and resolution_disposition is null
      and resolution_note is null
      and replacement_quote_id is null
      and replacement_quote_version is null
    )
    or
    (
      status = 'resolved'
      and resolved_at is not null
      and resolved_by is not null
      and resolution_disposition = 'replacement_published'
      and replacement_quote_id is not null
      and replacement_quote_version is not null
    )
    or
    (
      status = 'cancelled'
      and resolved_at is not null
      and resolved_by is not null
      and resolution_disposition = 'cancelled'
      and nullif(btrim(resolution_note), '') is not null
      and replacement_quote_id is null
      and replacement_quote_version is null
    )
  )
);

create index customer_quote_change_requests_queue_idx
  on public.customer_quote_change_requests(company_id, status, created_at)
  where status in ('submitted', 'reviewing');

alter table public.customer_quote_commands enable row level security;
alter table public.customer_quote_commands force row level security;
alter table public.customer_quote_change_requests enable row level security;
alter table public.customer_quote_change_requests force row level security;

revoke all on table public.customer_quote_commands
  from public, anon, authenticated, service_role;
revoke all on table public.customer_quote_change_requests
  from public, anon, authenticated, service_role;
revoke insert, update, delete on table public.quotes from authenticated;

create trigger customer_quote_change_requests_touch
  before update on public.customer_quote_change_requests
  for each row execute function public.touch_record();

create or replace function public.enforce_quote_commercial_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
    and old.status = 'accepted'
    and to_jsonb(new) is distinct from to_jsonb(old)
  then
    raise exception using message = 'ACCEPTED_QUOTE_IMMUTABLE';
  end if;
  if new.status in ('sent', 'viewed', 'accepted', 'declined', 'change_requested')
    and new.portal_published_at is null
  then
    new.portal_published_at := coalesce(new.portal_published_at, now());
  end if;
  if new.status in ('viewed', 'accepted', 'declined', 'change_requested')
    and new.portal_published_at is null
  then
    raise exception using message = 'QUOTE_PORTAL_PUBLICATION_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger quotes_commercial_lifecycle
  before insert or update on public.quotes
  for each row execute function public.enforce_quote_commercial_lifecycle();

revoke all on function public.enforce_quote_commercial_lifecycle()
  from public, anon, authenticated, service_role;

-- Harden every existing customer-portal RPC with active-company membership.
create or replace function public.storyops_assert_customer_portal_subject(
  p_company_id uuid,
  p_customer_id uuid
)
returns uuid
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
begin
  if actor_user_id is null then
    raise exception using message = 'CUSTOMER_PORTAL_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    join public.companies company
      on company.id = membership.company_id
     and company.status = 'active'
    join public.customer_portal_users portal
      on portal.company_id = membership.company_id
     and portal.user_id = membership.user_id
     and portal.customer_id = p_customer_id
    where membership.company_id = p_company_id
      and membership.user_id = actor_user_id
      and membership.role = 'customer'
      and membership.active
  ) then
    raise exception using message = 'CUSTOMER_PORTAL_SCOPE_DENIED';
  end if;
  return actor_user_id;
end;
$$;

revoke all on function public.storyops_assert_customer_portal_subject(uuid, uuid)
  from public, anon, authenticated, service_role;

-- SQL role membership is not an Edge identity. A missing JWT role claim must
-- fail closed even when a maintenance connection can SET ROLE service_role.
create or replace function private.assert_storyops_edge_actor(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_allowed_roles text[]
)
returns public.app_role
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_role public.app_role;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'EDGE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_company_id is null
    or p_actor_user_id is null
    or p_allowed_roles is null
    or cardinality(p_allowed_roles) < 1
    or cardinality(p_allowed_roles) > 4
    or p_allowed_roles <@ array[
      'owner', 'dispatcher', 'technician', 'customer'
    ]::text[] is false
  then
    raise exception using message = 'EDGE_ACTOR_INPUT_INVALID';
  end if;
  select membership.role
  into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
   and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active
    and membership.role::text = any(p_allowed_roles);
  if actor_role is null then
    raise exception using message = 'EDGE_ACTOR_FORBIDDEN';
  end if;
  return actor_role;
end;
$$;

revoke all on function private.assert_storyops_edge_actor(uuid, uuid, text[])
  from public, anon, authenticated, service_role;

create or replace function public.execute_customer_quote_action(
  p_company_id uuid,
  p_customer_id uuid,
  p_command_id uuid,
  p_action text,
  p_quote_id uuid,
  p_expected_quote_version integer,
  p_requested_service_codes text[],
  p_requested_add_on_codes text[],
  p_request_notes text,
  p_canonical_request text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid;
  existing_command public.customer_quote_commands%rowtype;
  quote_row public.quotes%rowtype;
  normalized_service_codes text[] := coalesce(p_requested_service_codes, '{}');
  normalized_add_on_codes text[] := coalesce(p_requested_add_on_codes, '{}');
  normalized_notes text := coalesce(btrim(p_request_notes), '');
  parsed_request jsonb;
  expected_request jsonb;
  effective_hash text;
  changed_quote public.quotes%rowtype;
  change_request_id uuid;
  quote_snapshot jsonb;
  result jsonb;
begin
  actor_user_id := public.storyops_assert_customer_portal_subject(
    p_company_id,
    p_customer_id
  );
  if p_command_id is null
    or p_quote_id is null
    or p_expected_quote_version < 1
    or p_action not in ('quote.view', 'quote.decline', 'quote.change_request')
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
    or octet_length(coalesce(p_canonical_request, '')) not between 2 and 12000
    or char_length(normalized_notes) > 2000
    or cardinality(normalized_service_codes) > 12
    or cardinality(normalized_add_on_codes) > 24
  then
    raise exception using message = 'CUSTOMER_QUOTE_ACTION_INVALID';
  end if;
  if normalized_service_codes <> (
      select coalesce(array_agg(code order by code), '{}')
      from (select distinct unnest(normalized_service_codes) code) value
    )
    or normalized_add_on_codes <> (
      select coalesce(array_agg(code order by code), '{}')
      from (select distinct unnest(normalized_add_on_codes) code) value
    )
    or exists (
      select 1 from unnest(normalized_service_codes) code
      where code !~ '^[a-z0-9][a-z0-9_-]{0,79}$'
    )
    or exists (
      select 1 from unnest(normalized_add_on_codes) code
      where code !~ '^[a-z0-9][a-z0-9_-]{0,79}:[a-z0-9][a-z0-9_-]{0,79}$'
    )
  then
    raise exception using message = 'CUSTOMER_QUOTE_CHOICES_INVALID';
  end if;
  if p_action = 'quote.view'
    and (
      cardinality(normalized_service_codes) <> 0
      or cardinality(normalized_add_on_codes) <> 0
      or normalized_notes <> ''
    )
  then
    raise exception using message = 'CUSTOMER_QUOTE_VIEW_FIELDS_FORBIDDEN';
  end if;
  if p_action = 'quote.decline'
    and (
      cardinality(normalized_service_codes) <> 0
      or cardinality(normalized_add_on_codes) <> 0
      or char_length(normalized_notes) > 1000
    )
  then
    raise exception using message = 'CUSTOMER_QUOTE_DECLINE_FIELDS_INVALID';
  end if;
  if p_action = 'quote.change_request'
    and cardinality(normalized_service_codes) = 0
    and cardinality(normalized_add_on_codes) = 0
    and normalized_notes = ''
  then
    raise exception using message = 'CUSTOMER_QUOTE_CHANGE_REQUEST_EMPTY';
  end if;

  begin
    parsed_request := p_canonical_request::jsonb;
  exception
    when others then
      raise exception using message = 'CUSTOMER_QUOTE_CANONICAL_REQUEST_INVALID';
  end;
  expected_request := jsonb_build_object(
    'action', p_action,
    'payload', jsonb_build_object(
      'addOnCodes', to_jsonb(normalized_add_on_codes),
      'customerId', p_customer_id,
      'notes', normalized_notes,
      'quoteId', p_quote_id,
      'quoteVersion', p_expected_quote_version,
      'serviceCodes', to_jsonb(normalized_service_codes)
    )
  );
  effective_hash := encode(
    extensions.digest(convert_to(p_canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  if parsed_request <> expected_request or effective_hash <> p_request_hash then
    raise exception using message = 'CUSTOMER_QUOTE_REQUEST_HASH_MISMATCH';
  end if;

  select *
  into existing_command
  from public.customer_quote_commands command
  where command.company_id = p_company_id
    and command.id = p_command_id
  for update;
  if found then
    if existing_command.customer_id <> p_customer_id
      or existing_command.actor_user_id <> actor_user_id
      or existing_command.quote_id <> p_quote_id
      or existing_command.expected_quote_version <> p_expected_quote_version
      or existing_command.action <> p_action
      or existing_command.request_hash <> p_request_hash
      or existing_command.canonical_request <> p_canonical_request
    then
      raise exception using message = 'CUSTOMER_QUOTE_IDEMPOTENCY_CONFLICT';
    end if;
    return existing_command.response || jsonb_build_object('replayed', true);
  end if;

  select *
  into quote_row
  from public.quotes quote
  where quote.company_id = p_company_id
    and quote.customer_id = p_customer_id
    and quote.id = p_quote_id
  for update;
  if not found then
    raise exception using message = 'CUSTOMER_QUOTE_SCOPE_DENIED';
  end if;

  -- A concurrent identical command may have committed while this transaction
  -- waited on the quote row. Re-read after the lock before treating the newer
  -- quote version as a conflict.
  select *
  into existing_command
  from public.customer_quote_commands command
  where command.company_id = p_company_id
    and command.id = p_command_id;
  if found then
    if existing_command.customer_id <> p_customer_id
      or existing_command.actor_user_id <> actor_user_id
      or existing_command.quote_id <> p_quote_id
      or existing_command.expected_quote_version <> p_expected_quote_version
      or existing_command.action <> p_action
      or existing_command.request_hash <> p_request_hash
      or existing_command.canonical_request <> p_canonical_request
    then
      raise exception using message = 'CUSTOMER_QUOTE_IDEMPOTENCY_CONFLICT';
    end if;
    return existing_command.response || jsonb_build_object('replayed', true);
  end if;

  if quote_row.version <> p_expected_quote_version then
    raise exception using message = 'CUSTOMER_QUOTE_VERSION_CONFLICT';
  end if;
  if quote_row.valid_until < current_date then
    raise exception using message = 'CUSTOMER_QUOTE_EXPIRED';
  end if;

  if p_action = 'quote.view' then
    if quote_row.status = 'sent' then
      update public.quotes
      set status = 'viewed'
      where id = quote_row.id
        and company_id = p_company_id
        and version = p_expected_quote_version
      returning * into changed_quote;
    elsif quote_row.status = 'viewed' then
      changed_quote := quote_row;
    else
      raise exception using message = 'CUSTOMER_QUOTE_VIEW_NOT_ELIGIBLE';
    end if;
  elsif p_action = 'quote.decline' then
    if quote_row.status not in ('sent', 'viewed') then
      raise exception using message = 'CUSTOMER_QUOTE_DECLINE_NOT_ELIGIBLE';
    end if;
    update public.quotes
    set status = 'declined'
    where id = quote_row.id
      and company_id = p_company_id
      and version = p_expected_quote_version
    returning * into changed_quote;
  else
    if quote_row.status not in ('sent', 'viewed') then
      raise exception using message = 'CUSTOMER_QUOTE_CHANGE_NOT_ELIGIBLE';
    end if;
    if (
      select count(distinct service.code)
      from public.service_catalog service
      join public.price_book_service_rules rule
        on rule.service_catalog_id = service.id
       and rule.company_id = service.company_id
      join public.price_books book
        on book.id = rule.price_book_id
       and book.company_id = rule.company_id
       and book.status = 'active'
      where service.company_id = p_company_id
        and service.active
        and service.code = any(normalized_service_codes)
    ) <> cardinality(normalized_service_codes)
    then
      raise exception using message = 'CUSTOMER_QUOTE_SERVICE_CHOICE_STALE';
    end if;
    if (
      select count(distinct rule.service_code || ':' || add_on.code)
      from public.price_book_add_ons add_on
      join public.price_book_service_rules rule
        on rule.id = add_on.service_rule_id
       and rule.company_id = add_on.company_id
      join public.price_books book
        on book.id = rule.price_book_id
       and book.company_id = rule.company_id
       and book.status = 'active'
      join public.service_catalog service
        on service.id = rule.service_catalog_id
       and service.company_id = rule.company_id
       and service.active
      where add_on.company_id = p_company_id
        and rule.service_code || ':' || add_on.code = any(normalized_add_on_codes)
    ) <> cardinality(normalized_add_on_codes)
    then
      raise exception using message = 'CUSTOMER_QUOTE_ADD_ON_CHOICE_STALE';
    end if;

    select jsonb_build_object(
      'quoteId', quote_row.id,
      'quoteNumber', quote_row.quote_number,
      'quoteVersion', quote_row.version,
      'estimateId', quote_row.estimate_id,
      'propertyId', quote_row.property_id,
      'status', quote_row.status,
      'validUntil', quote_row.valid_until,
      'termsVersion', quote_row.terms_version,
      'termsSha256', encode(
        extensions.digest(convert_to(quote_row.terms_snapshot, 'UTF8'), 'sha256'
      ), 'hex'),
      'total', quote_row.total::text,
      'depositRequired', quote_row.deposit_required::text,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
          'lineKind', line.line_kind,
          'serviceCode', line.service_code,
          'addOnCode', line.add_on_code,
          'description', line.description,
          'quantity', line.quantity::text,
          'unit', line.unit,
          'subtotal', line.subtotal::text,
          'sortOrder', line.sort_order
        ) order by line.sort_order)
        from public.estimate_lines line
        where line.company_id = p_company_id
          and line.estimate_id = quote_row.estimate_id
      ), '[]'::jsonb)
    )
    into quote_snapshot;

    update public.quotes
    set status = 'change_requested'
    where id = quote_row.id
      and company_id = p_company_id
      and version = p_expected_quote_version
    returning * into changed_quote;
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-customer-quote-action-v1',
    'companyId', p_company_id,
    'customerId', p_customer_id,
    'commandId', p_command_id,
    'action', p_action,
    'requestHash', p_request_hash,
    'quoteId', changed_quote.id,
    'quoteVersion', changed_quote.version,
    'quoteStatus', changed_quote.status,
    'priceChanged', false,
    'termsChanged', false,
    'accepted', false,
    'deliveryAsserted', false,
    'replayed', false,
    'serverTime', now()
  );

  insert into public.customer_quote_commands(
    id, company_id, customer_id, actor_user_id, quote_id,
    expected_quote_version, action, canonical_request, request_hash, response
  )
  values (
    p_command_id, p_company_id, p_customer_id, actor_user_id, p_quote_id,
    p_expected_quote_version, p_action, p_canonical_request, p_request_hash, result
  );

  if p_action = 'quote.change_request' then
    insert into public.customer_quote_change_requests(
      company_id, customer_id, property_id, quote_id, quote_version, command_id,
      requested_service_codes, requested_add_on_codes, request_notes, quote_snapshot
    )
    values (
      p_company_id, p_customer_id, quote_row.property_id, p_quote_id,
      p_expected_quote_version, p_command_id, normalized_service_codes,
      normalized_add_on_codes, normalized_notes, quote_snapshot
    )
    returning id into change_request_id;
    result := result || jsonb_build_object('changeRequestId', change_request_id);
    update public.customer_quote_commands
    set response = result
    where company_id = p_company_id and id = p_command_id;
  end if;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    before_data, after_data, retention_class, retain_until
  )
  values (
    p_company_id,
    'customer',
    actor_user_id::text,
    p_action,
    case when p_action = 'quote.change_request'
      then 'customer_quote_change_request' else 'quote' end,
    coalesce(change_request_id, p_quote_id),
    jsonb_build_object(
      'quoteId', quote_row.id,
      'quoteVersion', quote_row.version,
      'quoteStatus', quote_row.status
    ),
    jsonb_build_object(
      'quoteId', changed_quote.id,
      'quoteVersion', changed_quote.version,
      'quoteStatus', changed_quote.status,
      'requestHash', p_request_hash,
      'priceChanged', false,
      'termsChanged', false,
      'deliveryAsserted', false
    ),
    'audit',
    now() + interval '7 years'
  );
  return result;
end;
$$;

revoke all on function public.execute_customer_quote_action(
  uuid, uuid, uuid, text, uuid, integer, text[], text[], text, text, text
) from public, anon, service_role;
grant execute on function public.execute_customer_quote_action(
  uuid, uuid, uuid, text, uuid, integer, text[], text[], text, text, text
) to authenticated;

create or replace function public.resolve_customer_quote_change_request(
  p_company_id uuid,
  p_command_id uuid,
  p_request_id uuid,
  p_expected_request_version integer,
  p_disposition text,
  p_replacement_quote_id uuid,
  p_replacement_quote_version integer,
  p_resolution_note text,
  p_canonical_request text,
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
  request_row public.customer_quote_change_requests%rowtype;
  replacement_quote public.quotes%rowtype;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  parsed_request jsonb;
  expected_request jsonb;
  effective_hash text;
  normalized_note text := coalesce(btrim(p_resolution_note), '');
  result jsonb;
begin
  select membership.role
  into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
   and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role is null or actor_role not in ('owner', 'dispatcher') then
    raise exception using message = 'QUOTE_CHANGE_RESOLUTION_ROLE_REQUIRED';
  end if;
  if p_command_id is null
    or p_request_id is null
    or p_expected_request_version < 1
    or p_disposition not in ('replacement_published', 'cancelled')
    or p_canonical_request is null
    or char_length(normalized_note) > 2000
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'QUOTE_CHANGE_RESOLUTION_INVALID';
  end if;
  if p_disposition = 'replacement_published'
    and (p_replacement_quote_id is null or p_replacement_quote_version < 1)
  then
    raise exception using message = 'QUOTE_CHANGE_REPLACEMENT_REQUIRED';
  elsif p_disposition = 'cancelled'
    and (
      p_replacement_quote_id is not null
      or p_replacement_quote_version is not null
      or normalized_note = ''
    )
  then
    raise exception using message = 'QUOTE_CHANGE_CANCELLATION_REASON_REQUIRED';
  end if;

  begin
    parsed_request := p_canonical_request::jsonb;
  exception
    when others then
      raise exception using message = 'QUOTE_CHANGE_RESOLUTION_CANONICAL_INVALID';
  end;
  expected_request := jsonb_build_object(
    'action', 'quote.change_request.resolve',
    'payload', jsonb_build_object(
      'disposition', p_disposition,
      'expectedRequestVersion', p_expected_request_version,
      'replacementQuoteId', p_replacement_quote_id,
      'replacementQuoteVersion', p_replacement_quote_version,
      'requestId', p_request_id,
      'resolutionNote', normalized_note
    )
  );
  effective_hash := encode(
    extensions.digest(convert_to(p_canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  if parsed_request <> expected_request or effective_hash <> p_request_hash then
    raise exception using message = 'QUOTE_CHANGE_RESOLUTION_HASH_MISMATCH';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id, 'quote-change-resolution-v1', p_command_id::text,
    p_request_hash, now() + interval '7 years'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;
  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'quote-change-resolution-v1'
      and key = p_command_id::text
    for update;
    if reservation.request_hash <> p_request_hash then
      raise exception using message = 'QUOTE_CHANGE_RESOLUTION_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    else
      raise exception using message = 'QUOTE_CHANGE_RESOLUTION_IN_PROGRESS';
    end if;
  end if;

  select *
  into request_row
  from public.customer_quote_change_requests request
  where request.company_id = p_company_id
    and request.id = p_request_id
  for update;
  if not found
    or request_row.version <> p_expected_request_version
    or request_row.status not in ('submitted', 'reviewing')
  then
    raise exception using message = 'QUOTE_CHANGE_RESOLUTION_VERSION_CONFLICT';
  end if;

  if p_disposition = 'replacement_published' then
    select *
    into replacement_quote
    from public.quotes quote
    where quote.company_id = p_company_id
      and quote.id = p_replacement_quote_id
      and quote.customer_id = request_row.customer_id
      and quote.property_id = request_row.property_id;
    if not found
      or replacement_quote.id = request_row.quote_id
      or replacement_quote.version <> p_replacement_quote_version
      or replacement_quote.portal_published_at is null
      or replacement_quote.status not in ('sent', 'viewed', 'accepted')
      or replacement_quote.created_at <= request_row.created_at
    then
      raise exception using message = 'QUOTE_CHANGE_REPLACEMENT_NOT_PUBLISHED';
    end if;
  end if;

  update public.customer_quote_change_requests
  set status = case
        when p_disposition = 'replacement_published' then 'resolved'
        else 'cancelled'
      end,
      resolution_disposition = p_disposition,
      resolution_note = nullif(normalized_note, ''),
      replacement_quote_id = p_replacement_quote_id,
      replacement_quote_version = p_replacement_quote_version,
      resolved_by = actor_user_id,
      resolved_at = now()
  where id = request_row.id
    and company_id = p_company_id
    and version = p_expected_request_version
  returning version into p_expected_request_version;
  if not found then
    raise exception using message = 'QUOTE_CHANGE_RESOLUTION_VERSION_CONFLICT';
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-quote-change-resolution-v1',
    'companyId', p_company_id,
    'commandId', p_command_id,
    'requestId', request_row.id,
    'requestVersion', p_expected_request_version,
    'disposition', p_disposition,
    'replacementQuoteId', p_replacement_quote_id,
    'replacementQuoteVersion', p_replacement_quote_version,
    'requestHash', p_request_hash,
    'replayed', false,
    'serverTime', now()
  );
  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = reservation_id and status = 'in_progress';
  if not found then
    raise exception using message = 'QUOTE_CHANGE_RESOLUTION_RESERVATION_LOST';
  end if;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    before_data, after_data, retention_class, retain_until
  )
  values (
    p_company_id, 'user', actor_user_id::text, 'quote.change_request.resolve',
    'customer_quote_change_request', request_row.id,
    jsonb_build_object(
      'status', request_row.status,
      'version', request_row.version,
      'quoteId', request_row.quote_id,
      'quoteVersion', request_row.quote_version
    ),
    jsonb_build_object(
      'status', case
        when p_disposition = 'replacement_published' then 'resolved'
        else 'cancelled'
      end,
      'version', p_expected_request_version,
      'disposition', p_disposition,
      'replacementQuoteId', p_replacement_quote_id,
      'replacementQuoteVersion', p_replacement_quote_version,
      'requestHash', p_request_hash
    ),
    'audit', now() + interval '7 years'
  );
  return result;
end;
$$;

revoke all on function public.resolve_customer_quote_change_request(
  uuid, uuid, uuid, integer, text, uuid, integer, text, text, text
) from public, anon, service_role;
grant execute on function public.resolve_customer_quote_change_request(
  uuid, uuid, uuid, integer, text, uuid, integer, text, text, text
) to authenticated;

-- Add commercial facts without weakening the existing request/consent RPC.
alter function public.get_customer_portal_state(uuid)
  rename to get_customer_portal_state_v1_0;

revoke all on function public.get_customer_portal_state_v1_0(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_customer_portal_state(
  p_company_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  base_state jsonb;
  customer_state jsonb;
  enriched_customers jsonb := '[]'::jsonb;
  customer_id_value uuid;
  commercial_state jsonb;
begin
  if actor_user_id is null
    or not exists (
      select 1
      from public.company_memberships membership
      join public.companies company
        on company.id = membership.company_id
       and company.status = 'active'
      where membership.company_id = p_company_id
        and membership.user_id = actor_user_id
        and membership.role = 'customer'
        and membership.active
    )
  then
    raise exception using message = 'CUSTOMER_PORTAL_SCOPE_DENIED';
  end if;

  base_state := public.get_customer_portal_state_v1_0(p_company_id);
  for customer_state in
    select value from jsonb_array_elements(coalesce(base_state -> 'customers', '[]'::jsonb))
  loop
    customer_id_value := (customer_state ->> 'customerId')::uuid;
    perform public.storyops_assert_customer_portal_subject(
      p_company_id, customer_id_value
    );

    select jsonb_build_object(
      'quote', (
        select jsonb_build_object(
          'id', quote.id,
          'quoteNumber', quote.quote_number,
          'estimateId', quote.estimate_id,
          'propertyId', quote.property_id,
          'status', quote.status,
          'validUntil', quote.valid_until,
          'termsVersion', quote.terms_version,
          'termsSnapshot', quote.terms_snapshot,
          'total', quote.total::text,
          'depositRequired', quote.deposit_required::text,
          'portalPublishedAt', quote.portal_published_at,
          'deliveryStatus', 'not_asserted',
          'acceptedAt', quote.accepted_at,
          'version', quote.version,
          'lines', coalesce((
            select jsonb_agg(jsonb_build_object(
              'lineKind', line.line_kind,
              'serviceCode', line.service_code,
              'addOnCode', line.add_on_code,
              'description', line.description,
              'quantity', line.quantity::text,
              'unit', line.unit,
              'subtotal', line.subtotal::text,
              'sortOrder', line.sort_order
            ) order by line.sort_order)
            from public.estimate_lines line
            where line.company_id = p_company_id
              and line.estimate_id = quote.estimate_id
          ), '[]'::jsonb)
        )
        from public.quotes quote
        where quote.company_id = p_company_id
          and quote.customer_id = customer_id_value
          and quote.portal_published_at is not null
          and quote.status in (
            'sent', 'viewed', 'accepted', 'declined', 'change_requested', 'expired'
          )
        order by quote.created_at desc, quote.id desc
        limit 1
      ),
      'serviceOptions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'code', option.code,
          'name', option.name
        ) order by option.name, option.code)
        from (
          select distinct service.code, service.name
          from public.service_catalog service
          join public.price_book_service_rules rule
            on rule.service_catalog_id = service.id
           and rule.company_id = service.company_id
          join public.price_books book
            on book.id = rule.price_book_id
           and book.company_id = rule.company_id
           and book.status = 'active'
          where service.company_id = p_company_id
            and service.active
        ) option
      ), '[]'::jsonb),
      'addOnOptions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'selectionCode', option.selection_code,
          'serviceCode', option.service_code,
          'code', option.code,
          'name', option.name
        ) order by option.service_code, option.name, option.code)
        from (
          select distinct
            rule.service_code || ':' || add_on.code as selection_code,
            rule.service_code,
            add_on.code,
            add_on.name
          from public.price_book_add_ons add_on
          join public.price_book_service_rules rule
            on rule.id = add_on.service_rule_id
           and rule.company_id = add_on.company_id
          join public.price_books book
            on book.id = rule.price_book_id
           and book.company_id = rule.company_id
           and book.status = 'active'
          join public.service_catalog service
            on service.id = rule.service_catalog_id
           and service.company_id = rule.company_id
           and service.active
          where add_on.company_id = p_company_id
        ) option
      ), '[]'::jsonb),
      'changeRequests', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', request.id,
          'quoteId', request.quote_id,
          'quoteVersion', request.quote_version,
          'requestedServiceCodes', request.requested_service_codes,
          'requestedAddOnCodes', request.requested_add_on_codes,
          'requestNotes', request.request_notes,
          'status', request.status,
          'createdAt', request.created_at,
          'version', request.version
        ) order by request.created_at desc)
        from public.customer_quote_change_requests request
        where request.company_id = p_company_id
          and request.customer_id = customer_id_value
      ), '[]'::jsonb),
      'invoices', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', invoice.id,
          'invoiceNumber', invoice.invoice_number,
          'jobId', invoice.job_id,
          'status', invoice.status,
          'issueDate', invoice.issue_date,
          'dueDate', invoice.due_date,
          'total', invoice.total::text,
          'amountPaid', invoice.amount_paid::text,
          'balanceDue', invoice.balance_due::text,
          'version', invoice.version
        ) order by invoice.issue_date desc, invoice.id desc)
        from public.invoices invoice
        where invoice.company_id = p_company_id
          and invoice.customer_id = customer_id_value
          and invoice.status in ('open', 'past_due', 'paid')
      ), '[]'::jsonb),
      'depositEvidence', (
        select jsonb_build_object(
          'quoteId', quote.id,
          'required', quote.deposit_required::text,
          'verified', coalesce(invoice.amount_paid, 0)::text,
          'ready', quote.deposit_required = 0
            or coalesce(invoice.amount_paid, 0) >= quote.deposit_required
        )
        from public.quotes quote
        left join public.jobs job
          on job.company_id = quote.company_id
         and job.quote_id = quote.id
        left join public.invoices invoice
          on invoice.company_id = job.company_id
         and invoice.job_id = job.id
         and invoice.purpose = 'job'
        where quote.company_id = p_company_id
          and quote.customer_id = customer_id_value
          and quote.status = 'accepted'
        order by quote.accepted_at desc, quote.id desc
        limit 1
      )
    )
    into commercial_state;

    enriched_customers := enriched_customers || jsonb_build_array(
      (customer_state - 'serviceOptions')
      || jsonb_build_object(
        'serviceOptions', commercial_state -> 'serviceOptions',
        'commercial', commercial_state - 'serviceOptions'
      )
    );
  end loop;

  return jsonb_set(
    jsonb_set(
      base_state,
      '{schemaVersion}',
      to_jsonb('storyops-customer-portal-state-v2'::text)
    ),
    '{customers}',
    enriched_customers
  );
end;
$$;

revoke all on function public.get_customer_portal_state(uuid)
  from public, anon, service_role;
grant execute on function public.get_customer_portal_state(uuid)
  to authenticated;

-- Customer workspace projection must not disclose internal invoice states.
alter function public.get_storyops_workspace(uuid)
  rename to get_storyops_workspace_v1_0;

revoke all on function public.get_storyops_workspace_v1_0(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_storyops_workspace(
  p_company_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  result jsonb;
  eligible_quotes jsonb;
  eligible_invoices jsonb;
  eligible_payments jsonb;
begin
  if actor_user_id is null then
    raise exception using message = 'Authentication is required';
  end if;
  select membership.role
  into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
   and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role is null then
    raise exception using message = 'No active company membership';
  end if;
  if actor_role = 'customer' and not exists (
    select 1
    from public.customer_portal_users portal
    join public.customers customer
      on customer.id = portal.customer_id
     and customer.company_id = portal.company_id
    where portal.company_id = p_company_id
      and portal.user_id = actor_user_id
  ) then
    raise exception using message = 'No active customer portal mapping';
  end if;

  result := public.get_storyops_workspace_v1_0(p_company_id);
  if result #>> '{session,userId}' is distinct from actor_user_id::text
    or result #>> '{session,companyId}' is distinct from p_company_id::text
    or result #>> '{session,role}' is distinct from actor_role::text
  then
    raise exception using message = 'Workspace identity did not match the authenticated scope';
  end if;
  if result #>> '{session,role}' = 'customer' then
    select coalesce(
      jsonb_agg(projected_quote.value order by projected_quote.ordinal),
      '[]'::jsonb
    )
    into eligible_quotes
    from jsonb_array_elements(
      coalesce(result -> 'quotes', '[]'::jsonb)
    ) with ordinality projected_quote(value, ordinal)
    where exists (
      select 1
      from public.quotes quote
      join public.customer_portal_users portal
        on portal.company_id = quote.company_id
       and portal.customer_id = quote.customer_id
       and portal.user_id = actor_user_id
      where quote.company_id = p_company_id
        and quote.id = (projected_quote.value ->> 'id')::uuid
        and quote.portal_published_at is not null
    );

    select coalesce(jsonb_agg(invoice order by invoice ->> 'issueDate' desc), '[]'::jsonb)
    into eligible_invoices
    from jsonb_array_elements(coalesce(result -> 'invoices', '[]'::jsonb)) invoice
    where invoice ->> 'status' in ('open', 'past_due', 'paid');

    select coalesce(jsonb_agg(payment order by payment ->> 'id'), '[]'::jsonb)
    into eligible_payments
    from jsonb_array_elements(coalesce(result -> 'payments', '[]'::jsonb)) payment
    where exists (
      select 1
      from jsonb_array_elements(eligible_invoices) invoice
      where invoice ->> 'id' = payment ->> 'invoiceId'
    );

    result := jsonb_set(result, '{quotes}', eligible_quotes);
    result := jsonb_set(result, '{invoices}', eligible_invoices);
    result := jsonb_set(result, '{payments}', eligible_payments);
  elsif result #>> '{session,role}' in ('owner', 'dispatcher') then
    result := result || jsonb_build_object(
      'customerQuoteChangeRequests',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', request.id,
          'customerId', request.customer_id,
          'propertyId', request.property_id,
          'quoteId', request.quote_id,
          'quoteNumber', quote.quote_number,
          'quoteVersion', request.quote_version,
          'requestedServiceCodes', request.requested_service_codes,
          'requestedAddOnCodes', request.requested_add_on_codes,
          'requestNotes', request.request_notes,
          'status', request.status,
          'createdAt', request.created_at,
          'version', request.version,
          'nextAction', 'Re-estimate from current evidence, review policy, then publish a new quote version to the portal.'
        ) order by request.created_at desc)
        from public.customer_quote_change_requests request
        join public.quotes quote
          on quote.id = request.quote_id
         and quote.company_id = request.company_id
        where request.company_id = p_company_id
          and request.status in ('submitted', 'reviewing')
      ), '[]'::jsonb)
    );
  end if;
  return result;
end;
$$;

revoke all on function public.get_storyops_workspace(uuid)
  from public, anon, service_role;
grant execute on function public.get_storyops_workspace(uuid)
  to authenticated;

create or replace function public.load_storyops_invoice_checkout_validation(
  p_company_id uuid,
  p_invoice_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, auth
as $$
declare
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'EDGE_SERVICE_ROLE_REQUIRED';
  end if;
  select to_jsonb(value)
  into result
  from (
    select invoice.id, invoice.customer_id, invoice.job_id, job.quote_id,
           invoice.status, invoice.issue_date, invoice.due_date, invoice.total,
           invoice.amount_paid, invoice.balance_due, invoice.version
    from public.invoices invoice
    join public.jobs job
      on job.id = invoice.job_id
     and job.company_id = invoice.company_id
    join public.companies company
      on company.id = invoice.company_id
     and company.status = 'active'
    where invoice.company_id = p_company_id
      and invoice.id = p_invoice_id
      and invoice.status in ('open', 'past_due')
      and invoice.issue_date <= current_date
      and invoice.balance_due > 0
      and invoice.total = invoice.amount_paid + invoice.balance_due
  ) value;
  return result;
end;
$$;

revoke all on function public.load_storyops_invoice_checkout_validation(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_invoice_checkout_validation(uuid, uuid)
  to service_role;

create or replace function public.prepare_storyops_invoice_checkout(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_invoice_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions, auth
as $$
declare
  actor_role public.app_role;
  invoice_row public.invoices%rowtype;
  job_row public.jobs%rowtype;
  quote_row public.quotes%rowtype;
  payment_row public.payments%rowtype;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  request_hash text;
  provider_key text;
  claim jsonb;
begin
  if p_command_id is null or p_invoice_id is null or p_expected_version < 1 then
    raise exception using message = 'INVOICE_CHECKOUT_INVALID_REQUEST';
  end if;
  actor_role := private.assert_storyops_edge_actor(
    p_company_id,
    p_actor_user_id,
    array['owner', 'dispatcher', 'customer']
  );

  select *
  into invoice_row
  from public.invoices invoice
  where invoice.company_id = p_company_id
    and invoice.id = p_invoice_id
  for update;
  if not found then
    raise exception using message = 'INVOICE_CHECKOUT_NOT_FOUND';
  end if;
  if invoice_row.version <> p_expected_version then
    raise exception using message = 'INVOICE_CHECKOUT_VERSION_CONFLICT';
  end if;
  if actor_role = 'customer' and not exists (
    select 1
    from public.customer_portal_users portal
    where portal.company_id = p_company_id
      and portal.user_id = p_actor_user_id
      and portal.customer_id = invoice_row.customer_id
  ) then
    raise exception using message = 'INVOICE_CHECKOUT_CUSTOMER_SCOPE_DENIED';
  end if;
  if invoice_row.status not in ('open', 'past_due')
    or invoice_row.issue_date > current_date
    or invoice_row.balance_due <= 0
    or invoice_row.total <> invoice_row.amount_paid + invoice_row.balance_due
  then
    raise exception using message = 'INVOICE_CHECKOUT_NOT_PAYABLE';
  end if;

  select *
  into job_row
  from public.jobs job
  where job.company_id = p_company_id
    and job.id = invoice_row.job_id;
  if not found or job_row.customer_id <> invoice_row.customer_id then
    raise exception using message = 'INVOICE_CHECKOUT_JOB_MISMATCH';
  end if;
  select *
  into quote_row
  from public.quotes quote
  where quote.company_id = p_company_id
    and quote.id = job_row.quote_id;
  perform public.assert_storyops_accepted_pricing(p_company_id, quote_row.id);

  request_hash := encode(
    extensions.digest(jsonb_build_object(
      'action', 'invoice.checkout',
      'invoiceId', invoice_row.id,
      'expectedVersion', p_expected_version,
      'balanceDue', invoice_row.balance_due::text
    )::text, 'sha256'),
    'hex'
  );
  provider_key := 'storyops:invoice-balance:' || invoice_row.id::text
    || ':v' || p_expected_version::text
    || ':' || round(invoice_row.balance_due * 100)::bigint::text;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id, 'invoice-checkout-v1', p_command_id::text,
    request_hash, now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'invoice-checkout-v1'
      and key = p_command_id::text
    for update;
    if reservation.request_hash <> request_hash then
      raise exception using message = 'INVOICE_CHECKOUT_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return jsonb_build_object(
        'claimStatus', 'completed',
        'storedResponse', reservation.response
      );
    elsif reservation.status = 'in_progress'
      and reservation.locked_at >= now() - interval '5 minutes'
    then
      raise exception using message = 'INVOICE_CHECKOUT_IN_PROGRESS';
    end if;
    update public.idempotency_keys
    set status = 'in_progress',
        response = null,
        error_code = null,
        locked_at = now(),
        completed_at = null,
        expires_at = now() + interval '90 days'
    where id = reservation.id;
    reservation_id := reservation.id;
  end if;

  insert into public.payments(
    company_id, invoice_id, customer_id, provider, payment_type, status,
    amount, idempotency_key
  )
  values (
    p_company_id, invoice_row.id, invoice_row.customer_id, 'stripe', 'invoice',
    'pending', invoice_row.balance_due, provider_key
  )
  on conflict (company_id, idempotency_key) do nothing;

  select *
  into payment_row
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.idempotency_key = provider_key
  for update;
  if not found
    or payment_row.invoice_id <> invoice_row.id
    or payment_row.customer_id <> invoice_row.customer_id
    or payment_row.provider <> 'stripe'
    or payment_row.payment_type <> 'invoice'
    or payment_row.amount <> invoice_row.balance_due
    or payment_row.status not in ('pending', 'failed')
  then
    raise exception using message = 'INVOICE_CHECKOUT_PAYMENT_CONFLICT';
  end if;

  claim := jsonb_build_object(
    'claimStatus', 'reserved',
    'requestHash', request_hash,
    'quoteId', quote_row.id,
    'customerId', invoice_row.customer_id,
    'jobId', job_row.id,
    'invoiceId', invoice_row.id,
    'invoiceVersion', invoice_row.version,
    'paymentId', payment_row.id,
    'amount', invoice_row.balance_due::text,
    'currency', 'USD',
    'description', 'Balance for invoice ' || invoice_row.invoice_number,
    'providerIdempotencyKey', provider_key
  );
  update public.idempotency_keys
  set response = claim
  where id = reservation_id and status = 'in_progress';
  return claim;
end;
$$;

create or replace function public.complete_storyops_invoice_checkout(
  p_company_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_payment_id uuid,
  p_provider_checkout_id text,
  p_response jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  reservation public.idempotency_keys%rowtype;
  invoice_row public.invoices%rowtype;
  payment_row public.payments%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'EDGE_SERVICE_ROLE_REQUIRED';
  end if;
  select *
  into reservation
  from public.idempotency_keys
  where company_id = p_company_id
    and scope = 'invoice-checkout-v1'
    and key = p_command_id::text
    and request_hash = p_request_hash
    and status = 'in_progress'
  for update;
  if not found or reservation.response ->> 'paymentId' <> p_payment_id::text then
    raise exception using message = 'INVOICE_CHECKOUT_RESERVATION_LOST';
  end if;

  select *
  into payment_row
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.id = p_payment_id
  for update;
  select *
  into invoice_row
  from public.invoices invoice
  where invoice.company_id = p_company_id
    and invoice.id = payment_row.invoice_id
  for update;

  if p_provider_checkout_id !~ '^cs_'
    or jsonb_typeof(p_response) <> 'object'
    or p_response ->> 'action' <> 'invoice.checkout'
    or p_response ->> 'status' <> 'checkout_open'
    or p_response ->> 'checkoutId' <> p_provider_checkout_id
    or p_response ->> 'paymentVerified' <> 'false'
    or p_response ->> 'invoicePaid' <> 'false'
    or p_response ->> 'invoiceId' <> invoice_row.id::text
    or p_response ->> 'amount' <> to_char(payment_row.amount, 'FM9999999990.00')
    or invoice_row.version <> (reservation.response ->> 'invoiceVersion')::integer
    or invoice_row.status not in ('open', 'past_due')
    or invoice_row.balance_due <> payment_row.amount
    or payment_row.status not in ('pending', 'failed')
    or (
      payment_row.provider_payment_id is not null
      and payment_row.provider_payment_id <> p_provider_checkout_id
    )
  then
    raise exception using message = 'INVOICE_CHECKOUT_INVALID_PROVIDER_RECEIPT';
  end if;

  update public.payments
  set provider_payment_id = p_provider_checkout_id,
      status = 'pending',
      processed_at = null,
      failure_code = null
  where id = payment_row.id
    and company_id = p_company_id;

  update public.idempotency_keys
  set status = 'completed',
      response = p_response,
      error_code = null,
      completed_at = now()
  where id = reservation.id;
end;
$$;

create or replace function public.fail_storyops_invoice_checkout(
  p_company_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'EDGE_SERVICE_ROLE_REQUIRED';
  end if;
  update public.idempotency_keys
  set status = 'failed',
      error_code = left(regexp_replace(
        coalesce(nullif(btrim(p_error_code), ''), 'INVOICE_CHECKOUT_FAILED'),
        '[^A-Z0-9_]', '_', 'g'
      ), 120),
      completed_at = now()
  where company_id = p_company_id
    and scope = 'invoice-checkout-v1'
    and key = p_command_id::text
    and request_hash = p_request_hash
    and status = 'in_progress';
end;
$$;

revoke all on function public.prepare_storyops_invoice_checkout(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.complete_storyops_invoice_checkout(
  uuid, uuid, text, uuid, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.fail_storyops_invoice_checkout(
  uuid, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_storyops_invoice_checkout(
  uuid, uuid, uuid, uuid, integer
) to service_role;
grant execute on function public.complete_storyops_invoice_checkout(
  uuid, uuid, text, uuid, text, jsonb
) to service_role;
grant execute on function public.fail_storyops_invoice_checkout(
  uuid, uuid, text, text
) to service_role;

create or replace function public.refresh_storyops_invoice_balance_from_payment()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  invoice_row public.invoices%rowtype;
  verified_amount numeric(12,2);
begin
  if auth.role() is distinct from 'service_role'
    or new.provider <> 'stripe'
    or new.payment_type <> 'invoice'
    or new.status <> 'succeeded'
    or old.status = 'succeeded'
    or new.processed_at is null
    or new.provider_payment_id is null
  then
    return new;
  end if;
  select *
  into invoice_row
  from public.invoices invoice
  where invoice.id = new.invoice_id
    and invoice.company_id = new.company_id
  for update;
  if not found
    or invoice_row.customer_id <> new.customer_id
    or invoice_row.status not in ('open', 'past_due')
    or invoice_row.balance_due <= 0
    or new.amount <> invoice_row.balance_due
  then
    raise exception using message =
      'INVOICE_PAYMENT_RECONCILIATION_STALE_BALANCE';
  end if;
  verified_amount := new.amount;
  update public.invoices
  set amount_paid = amount_paid + verified_amount,
      balance_due = balance_due - verified_amount,
      status = 'paid',
      paid_at = coalesce(paid_at, new.processed_at)
  where id = invoice_row.id
    and company_id = new.company_id
    and version = invoice_row.version;
  if not found then
    raise exception using message =
      'INVOICE_PAYMENT_RECONCILIATION_VERSION_CONFLICT';
  end if;
  return new;
end;
$$;

create trigger payments_invoice_balance_reconciliation
  after update of status on public.payments
  for each row
  when (old.status is distinct from new.status)
  execute function public.refresh_storyops_invoice_balance_from_payment();

revoke all on function public.refresh_storyops_invoice_balance_from_payment()
  from public, anon, authenticated, service_role;

comment on column public.quotes.portal_published_at is
  'Authoritative portal publication time. Publication does not assert email/SMS delivery.';
comment on table public.customer_quote_change_requests is
  'Immutable customer request against one exact quote/version; it never changes price, terms, lines, or acceptance.';
comment on function public.execute_customer_quote_action(
  uuid, uuid, uuid, text, uuid, integer, text[], text[], text, text, text
) is
  'Authenticated, exact-scope, idempotent customer view/decline/change-request command boundary.';
comment on function public.prepare_storyops_invoice_checkout(
  uuid, uuid, uuid, uuid, integer
) is
  'Service-role-only exact issued-invoice balance reservation; creates pending payment state only.';
