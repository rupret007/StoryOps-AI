-- Owner-visible redacted audit feed and affirmative customer quote acceptance.
-- The generic workspace command may no longer infer a signer or accept terms.

create table public.customer_quote_acceptances (
  command_id uuid not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  quote_id uuid not null references public.quotes(id) on delete restrict,
  quote_version integer not null check (quote_version > 0),
  terms_version text not null check (
    nullif(btrim(terms_version), '') is not null
    and char_length(terms_version) <= 160
  ),
  accepted_total numeric(12,2) not null check (accepted_total >= 0),
  signer_name text not null check (
    char_length(btrim(signer_name)) between 2 and 120
  ),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  acknowledged boolean not null check (acknowledged),
  canonical_request text not null check (
    octet_length(canonical_request) between 2 and 12000
  ),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  acceptance_context_hash text not null check (
    acceptance_context_hash ~ '^[a-f0-9]{64}$'
  ),
  accepted_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (company_id, command_id),
  unique (company_id, quote_id)
);

create index customer_quote_acceptances_customer_idx
  on public.customer_quote_acceptances(company_id, customer_id, accepted_at desc);
create index audit_events_feed_idx
  on public.audit_events(company_id, occurred_at desc, id desc);

alter table public.customer_quote_acceptances enable row level security;
alter table public.customer_quote_acceptances force row level security;

revoke all on table public.customer_quote_acceptances
  from public, anon, authenticated, service_role;
-- A raw owner SELECT would defeat the redaction boundary below. Internal
-- writes continue through SECURITY DEFINER trigger/RPC paths.
revoke all on table public.audit_events
  from public, anon, authenticated, service_role;

create trigger customer_quote_acceptances_append_only
  before update or delete on public.customer_quote_acceptances
  for each row execute function public.reject_append_only_mutation();

create or replace function public.enforce_affirmative_quote_acceptance()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
    and new.status = 'accepted'
    and old.status is distinct from 'accepted'
    and not exists (
      select 1
      from public.customer_quote_acceptances acceptance
      where acceptance.company_id = old.company_id
        and acceptance.customer_id = old.customer_id
        and acceptance.quote_id = old.id
        and acceptance.quote_version = old.version
        and acceptance.terms_version = old.terms_version
        and acceptance.accepted_total = old.total
        and acceptance.signer_name = new.accepted_by_name
        and acceptance.actor_user_id = new.accepted_by_user_id
        and acceptance.acknowledged
        and acceptance.accepted_at = new.accepted_at
        and acceptance.acceptance_context_hash = new.acceptance_context_hash
    )
  then
    raise exception using message = 'AFFIRMATIVE_QUOTE_ACCEPTANCE_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger quotes_affirmative_acceptance
  before update on public.quotes
  for each row execute function public.enforce_affirmative_quote_acceptance();

revoke all on function public.enforce_affirmative_quote_acceptance()
  from public, anon, authenticated, service_role;

create or replace function public.accept_customer_quote(
  p_company_id uuid,
  p_customer_id uuid,
  p_command_id uuid,
  p_quote_id uuid,
  p_expected_quote_version integer,
  p_signer_name text,
  p_acknowledged boolean,
  p_terms_version text,
  p_total text,
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
  quote_row public.quotes%rowtype;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  parsed_request jsonb;
  expected_request jsonb;
  effective_hash text;
  normalized_signer text := btrim(coalesce(p_signer_name, ''));
  accepted_at_value timestamptz := now();
  context_hash text;
  resulting_version integer;
  result jsonb;
begin
  actor_user_id := public.storyops_assert_customer_portal_subject(
    p_company_id,
    p_customer_id
  );
  if p_command_id is null
    or p_quote_id is null
    or p_expected_quote_version is null
    or p_expected_quote_version < 1
    or p_acknowledged is distinct from true
    or char_length(normalized_signer) not between 2 and 120
    or normalized_signer ~ '[[:cntrl:]]'
    or nullif(btrim(coalesce(p_terms_version, '')), '') is null
    or char_length(p_terms_version) > 160
    or p_terms_version <> btrim(p_terms_version)
    or p_terms_version ~ '[[:cntrl:]]'
    or coalesce(p_total, '') !~ '^(0|[1-9][0-9]{0,9})[.][0-9]{2}$'
    or p_canonical_request is null
    or octet_length(p_canonical_request) not between 2 and 12000
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'QUOTE_ACCEPTANCE_INVALID';
  end if;

  begin
    parsed_request := p_canonical_request::jsonb;
  exception
    when others then
      raise exception using message = 'QUOTE_ACCEPTANCE_CANONICAL_INVALID';
  end;
  expected_request := jsonb_build_object(
    'action', 'quote.accept',
    'payload', jsonb_build_object(
      'acknowledged', true,
      'customerId', p_customer_id,
      'quoteId', p_quote_id,
      'quoteVersion', p_expected_quote_version,
      'signerName', normalized_signer,
      'termsVersion', p_terms_version,
      'total', p_total
    )
  );
  effective_hash := encode(
    extensions.digest(convert_to(p_canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  if parsed_request <> expected_request or effective_hash <> p_request_hash then
    raise exception using message = 'QUOTE_ACCEPTANCE_HASH_MISMATCH';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'customer-quote-acceptance-v1',
    p_command_id::text,
    p_request_hash,
    now() + interval '7 years'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;
  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'customer-quote-acceptance-v1'
      and key = p_command_id::text
    for update;
    if reservation.request_hash <> p_request_hash then
      raise exception using message = 'QUOTE_ACCEPTANCE_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    else
      raise exception using message = 'QUOTE_ACCEPTANCE_IN_PROGRESS';
    end if;
  end if;

  select *
  into quote_row
  from public.quotes quote
  where quote.company_id = p_company_id
    and quote.id = p_quote_id
    and quote.customer_id = p_customer_id
    and exists (
      select 1
      from public.customers customer
      where customer.company_id = quote.company_id
        and customer.id = quote.customer_id
        and customer.lifecycle <> 'blocked'
    )
  for update;
  if not found
    or quote_row.version <> p_expected_quote_version
    or quote_row.status not in ('sent', 'viewed')
    or quote_row.portal_published_at is null
    or quote_row.valid_until < current_date
  then
    raise exception using message = 'QUOTE_ACCEPTANCE_NOT_ELIGIBLE';
  end if;
  if quote_row.terms_version <> p_terms_version
    or quote_row.total <> p_total::numeric(12,2)
  then
    raise exception using message = 'QUOTE_ACCEPTANCE_CONTEXT_MISMATCH';
  end if;

  context_hash := encode(
    extensions.digest(
      convert_to(
        concat_ws(
          E'\x1f',
          actor_user_id::text,
          p_customer_id::text,
          p_quote_id::text,
          p_expected_quote_version::text,
          p_terms_version,
          p_total,
          normalized_signer,
          accepted_at_value::text,
          p_command_id::text,
          p_request_hash
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into public.customer_quote_acceptances(
    command_id, company_id, customer_id, quote_id, quote_version,
    terms_version, accepted_total, signer_name, actor_user_id, acknowledged,
    canonical_request, request_hash, acceptance_context_hash, accepted_at
  )
  values (
    p_command_id, p_company_id, p_customer_id, p_quote_id,
    p_expected_quote_version, p_terms_version, p_total::numeric(12,2),
    normalized_signer, actor_user_id, true, p_canonical_request,
    p_request_hash, context_hash, accepted_at_value
  );

  update public.quotes quote
  set status = 'accepted',
      accepted_at = accepted_at_value,
      accepted_by_name = normalized_signer,
      accepted_by_user_id = actor_user_id,
      acceptance_context_hash = context_hash
  where quote.company_id = p_company_id
    and quote.id = p_quote_id
    and quote.customer_id = p_customer_id
    and quote.version = p_expected_quote_version
    and quote.status in ('sent', 'viewed')
  returning quote.version into resulting_version;
  if not found then
    raise exception using message = 'QUOTE_ACCEPTANCE_VERSION_CONFLICT';
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-customer-quote-acceptance-v1',
    'companyId', p_company_id,
    'customerId', p_customer_id,
    'commandId', p_command_id,
    'requestHash', p_request_hash,
    'quoteId', p_quote_id,
    'expectedQuoteVersion', p_expected_quote_version,
    'quoteVersion', resulting_version,
    'termsVersion', p_terms_version,
    'total', p_total,
    'signerName', normalized_signer,
    'acknowledged', true,
    'acceptedAt', accepted_at_value,
    'acceptanceContextHash', context_hash,
    'replayed', false,
    'serverTime', now()
  );
  update public.idempotency_keys
  set status = 'completed',
      response = result,
      completed_at = now()
  where id = reservation_id
    and status = 'in_progress';
  if not found then
    raise exception using message = 'QUOTE_ACCEPTANCE_RESERVATION_LOST';
  end if;

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    before_data, after_data, request_id, retention_class, retain_until
  )
  values (
    p_company_id,
    'customer',
    actor_user_id::text,
    'quote.accept',
    'quote',
    p_quote_id,
    jsonb_build_object(
      'status', quote_row.status,
      'version', quote_row.version
    ),
    jsonb_build_object(
      'status', 'accepted',
      'version', resulting_version,
      'termsVersion', p_terms_version,
      'total', p_total,
      'acknowledged', true,
      'acceptanceContextHash', context_hash,
      'requestHash', p_request_hash
    ),
    p_command_id::text,
    'audit',
    now() + interval '7 years'
  );
  return result;
end;
$$;

revoke all on function public.accept_customer_quote(
  uuid, uuid, uuid, uuid, integer, text, boolean, text, text, text, text
) from public, anon, service_role;
grant execute on function public.accept_customer_quote(
  uuid, uuid, uuid, uuid, integer, text, boolean, text, text, text, text
) to authenticated;

create or replace function public.get_storyops_audit_feed(
  p_company_id uuid,
  p_before_occurred_at timestamptz,
  p_before_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  event_rows jsonb;
  has_more boolean;
  next_time timestamptz;
  next_id uuid;
begin
  select membership.role
  into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role is distinct from 'owner' then
    raise exception using message = 'AUDIT_FEED_OWNER_REQUIRED';
  end if;
  if p_limit is null
    or p_limit not between 1 and 100
    or ((p_before_occurred_at is null) <> (p_before_id is null))
  then
    raise exception using message = 'AUDIT_FEED_CURSOR_INVALID';
  end if;
  if p_before_occurred_at is not null
    and not exists (
      select 1
      from public.audit_events event
      where event.company_id = p_company_id
        and event.occurred_at = p_before_occurred_at
        and event.id = p_before_id
    )
  then
    raise exception using message = 'AUDIT_FEED_CURSOR_INVALID';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'occurredAt', page.occurred_at,
    'actorType', page.actor_type,
    'actorRef', concat(
      page.actor_type,
      ':',
      substr(
        encode(
          extensions.digest(
            convert_to(
              concat_ws(
                E'\x1f',
                p_company_id::text,
                page.actor_type,
                page.actor_id
              ),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        ),
        1,
        16
      )
    ),
    'action', page.action,
    'entityType', page.entity_type,
    'entityId', page.entity_id,
    'requestId', case
      when page.request_id is null then null
      when page.request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
        then page.request_id
      else concat(
        'sha256:',
        substr(
          encode(
            extensions.digest(
              convert_to(
                concat_ws(E'\x1f', p_company_id::text, page.request_id),
                'UTF8'
              ),
              'sha256'
            ),
            'hex'
          ),
          1,
          16
        )
      )
    end,
    'traceId', case
      when page.trace_id is null then null
      when page.trace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
        then page.trace_id
      else concat(
        'sha256:',
        substr(
          encode(
            extensions.digest(
              convert_to(
                concat_ws(E'\x1f', p_company_id::text, page.trace_id),
                'UTF8'
              ),
              'sha256'
            ),
            'hex'
          ),
          1,
          16
        )
      )
    end,
    'hasBefore', page.before_data is not null,
    'hasAfter', page.after_data is not null,
    'retentionClass', page.retention_class,
    'retainUntil', page.retain_until,
    'legalHold', page.legal_hold
  ) order by page.occurred_at desc, page.id desc), '[]'::jsonb)
  into event_rows
  from (
    select event.*
    from public.audit_events event
    where event.company_id = p_company_id
      and (
        p_before_occurred_at is null
        or (event.occurred_at, event.id) < (p_before_occurred_at, p_before_id)
      )
    order by event.occurred_at desc, event.id desc
    limit p_limit
  ) page;

  select exists (
    select 1
    from public.audit_events event
    where event.company_id = p_company_id
      and (
        p_before_occurred_at is null
        or (event.occurred_at, event.id) < (p_before_occurred_at, p_before_id)
      )
    order by event.occurred_at desc, event.id desc
    offset p_limit
    limit 1
  )
  into has_more;

  if has_more and jsonb_array_length(event_rows) > 0 then
    next_time := (event_rows -> -1 ->> 'occurredAt')::timestamptz;
    next_id := (event_rows -> -1 ->> 'id')::uuid;
  end if;

  return jsonb_build_object(
    'schemaVersion', 'storyops-audit-feed-v1',
    'companyId', p_company_id,
    'events', event_rows,
    'hasMore', has_more,
    'nextCursor', case
      when has_more then jsonb_build_object(
        'occurredAt', next_time,
        'id', next_id
      )
      else null
    end,
    'pageLimit', p_limit,
    'redacted', true,
    'serverTime', now()
  );
end;
$$;

revoke all on function public.get_storyops_audit_feed(
  uuid, timestamptz, uuid, integer
) from public, anon, service_role;
grant execute on function public.get_storyops_audit_feed(
  uuid, timestamptz, uuid, integer
) to authenticated;

comment on table public.customer_quote_acceptances is
  'Append-only affirmative quote/terms acceptance evidence. Authenticated users have no direct table access.';
comment on function public.accept_customer_quote(
  uuid, uuid, uuid, uuid, integer, text, boolean, text, text, text, text
) is
  'Exact customer quote acceptance; signer and affirmative terms context are supplied, matched, hashed, and retained.';
comment on function public.get_storyops_audit_feed(
  uuid, timestamptz, uuid, integer
) is
  'Owner-only bounded audit metadata feed. Before/after payloads and raw actor identifiers are never projected.';
