-- Server-authoritative quote-to-invoice golden path.
-- Provider checkout is prepared/completed only by the service role. Booking
-- and invoice issuance remain finite authenticated commands with DB-derived
-- RBAC, pricing, payment, capacity, and completion checks.

alter table public.invoices
  add column purpose text not null default 'job'
    check (purpose in ('job'));

alter table public.invoice_lines
  add column source_estimate_line_id uuid
    references public.estimate_lines(id) on delete restrict,
  add column line_kind text
    check (
      line_kind is null
      or line_kind in (
        'service', 'add_on', 'company_minimum', 'travel', 'manual_adjustment'
      )
    ),
  add column unit text;

create unique index jobs_one_per_quote_idx
  on public.jobs(company_id, quote_id);

create unique index invoices_one_per_job_purpose_idx
  on public.invoices(company_id, job_id, purpose)
  where job_id is not null;

create unique index payments_one_deposit_per_invoice_idx
  on public.payments(company_id, invoice_id)
  where payment_type = 'deposit';

create unique index invoice_lines_source_once_idx
  on public.invoice_lines(invoice_id, source_estimate_line_id)
  where source_estimate_line_id is not null;

create or replace function public.assert_storyops_accepted_pricing(
  p_company_id uuid,
  p_quote_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  quote_row public.quotes%rowtype;
  estimate_row public.estimates%rowtype;
  price_book_row public.price_books%rowtype;
  line_total numeric(12,2);
  expected_total numeric(12,2);
begin
  select *
  into quote_row
  from public.quotes
  where id = p_quote_id
    and company_id = p_company_id;

  if not found
    or quote_row.status <> 'accepted'
    or quote_row.accepted_at is null
    or quote_row.accepted_by_user_id is null
    or quote_row.acceptance_context_hash !~ '^[a-f0-9]{64}$'
    or quote_row.valid_until < quote_row.accepted_at::date
  then
    raise exception 'GOLDEN_PATH_ACCEPTED_QUOTE_REQUIRED';
  end if;

  select *
  into estimate_row
  from public.estimates
  where id = quote_row.estimate_id
    and company_id = p_company_id;

  if not found
    or estimate_row.status <> 'approved'
    or estimate_row.customer_id <> quote_row.customer_id
    or estimate_row.property_id <> quote_row.property_id
    or estimate_row.total <> quote_row.total
    or estimate_row.deposit_required <> quote_row.deposit_required
  then
    raise exception 'GOLDEN_PATH_ESTIMATE_QUOTE_MISMATCH';
  end if;

  select *
  into price_book_row
  from public.price_books
  where id = estimate_row.price_book_id
    and company_id = p_company_id;

  if not found
    or price_book_row.status not in ('active', 'retired')
    or price_book_row.version_label <> estimate_row.price_book_version
    or price_book_row.published_at is null
    or price_book_row.published_at > estimate_row.calculated_at
    or price_book_row.effective_from > estimate_row.calculated_at
    or (
      price_book_row.effective_until is not null
      and price_book_row.effective_until < estimate_row.calculated_at
    )
  then
    raise exception 'GOLDEN_PATH_PUBLISHED_PRICE_BOOK_REQUIRED';
  end if;

  select round(coalesce(sum(line.subtotal), 0), 2)
  into line_total
  from public.estimate_lines line
  where line.company_id = p_company_id
    and line.estimate_id = estimate_row.id;

  expected_total := round(
    estimate_row.service_subtotal
      + estimate_row.minimum_adjustment
      + estimate_row.travel_fee
      + estimate_row.manual_adjustment
      - estimate_row.discount
      + estimate_row.tax,
    2
  );

  if line_total <> round(
      estimate_row.service_subtotal
        + estimate_row.minimum_adjustment
        + estimate_row.travel_fee
        + estimate_row.manual_adjustment,
      2
    )
    or expected_total <> estimate_row.total
    or estimate_row.taxable_subtotal
      <> round(
        estimate_row.service_subtotal
          + estimate_row.minimum_adjustment
          + estimate_row.travel_fee
          + estimate_row.manual_adjustment
          - estimate_row.discount,
        2
      )
    or not exists (
      select 1
      from public.estimate_lines line
      where line.company_id = p_company_id
        and line.estimate_id = estimate_row.id
    )
  then
    raise exception 'GOLDEN_PATH_DETERMINISTIC_TOTAL_MISMATCH';
  end if;
end;
$$;

create or replace function public.storyops_payment_has_provider_proof(
  p_payment_id uuid,
  p_quote_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.payments payment
    join public.invoices invoice on invoice.id = payment.invoice_id
    join public.jobs job on job.id = invoice.job_id
    where payment.id = p_payment_id
      and job.quote_id = p_quote_id
      and payment.company_id = job.company_id
      and payment.provider = 'stripe'
      and payment.payment_type = 'deposit'
      and payment.status = 'succeeded'
      and payment.processed_at is not null
      and payment.provider_payment_id is not null
      and exists (
        select 1
        from public.webhook_events event
        where event.company_id = payment.company_id
          and event.provider = 'stripe'
          and event.status = 'processed'
          and event.payload ->> 'action' = 'payment_succeeded'
          and event.payload ->> 'quoteId' = p_quote_id::text
          and (event.payload ->> 'amountCents')::bigint
            = round(payment.amount * 100)::bigint
          and (
            event.payload ->> 'objectId' = payment.provider_payment_id
            or event.payload ->> 'paymentIntentId' = payment.provider_payment_id
          )
      )
  );
$$;

create or replace function public.refresh_storyops_deposit_state(
  p_company_id uuid,
  p_quote_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_row public.jobs%rowtype;
  quote_row public.quotes%rowtype;
  invoice_row public.invoices%rowtype;
  verified_deposit numeric(12,2) := 0;
begin
  select *
  into quote_row
  from public.quotes
  where id = p_quote_id
    and company_id = p_company_id;
  if not found then return; end if;

  select *
  into job_row
  from public.jobs
  where company_id = p_company_id
    and quote_id = p_quote_id;
  if not found then return; end if;

  select *
  into invoice_row
  from public.invoices
  where company_id = p_company_id
    and job_id = job_row.id
    and purpose = 'job';
  if not found then return; end if;

  select round(coalesce(sum(payment.amount), 0), 2)
  into verified_deposit
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.invoice_id = invoice_row.id
    and payment.payment_type = 'deposit'
    and public.storyops_payment_has_provider_proof(payment.id, p_quote_id);

  update public.invoices
  set
    amount_paid = least(total, verified_deposit),
    balance_due = greatest(0, total - least(total, verified_deposit))
  where id = invoice_row.id
    and (
      amount_paid <> least(total, verified_deposit)
      or balance_due <> greatest(0, total - least(total, verified_deposit))
    );

  if job_row.status = 'pending_deposit'
    and (
      quote_row.deposit_required = 0
      or verified_deposit >= quote_row.deposit_required
    )
  then
    update public.jobs
    set status = 'ready_to_schedule'
    where id = job_row.id
      and status = 'pending_deposit';
  end if;
end;
$$;

create or replace function public.refresh_storyops_deposit_from_webhook()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  quote_id_value uuid;
begin
  if new.provider = 'stripe'
    and new.status = 'processed'
    and new.payload ->> 'action' = 'payment_succeeded'
    and new.payload ->> 'quoteId' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    quote_id_value := (new.payload ->> 'quoteId')::uuid;
    perform public.refresh_storyops_deposit_state(new.company_id, quote_id_value);
  end if;
  return new;
end;
$$;

create trigger webhook_events_deposit_insert
  after insert on public.webhook_events
  for each row execute function public.refresh_storyops_deposit_from_webhook();

create trigger webhook_events_deposit_update
  after update of status on public.webhook_events
  for each row
  when (old.status is distinct from new.status)
  execute function public.refresh_storyops_deposit_from_webhook();

create or replace function public.sync_storyops_job_from_visit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status in ('en_route', 'on_site', 'paused')
    and old.status is distinct from new.status
  then
    update public.jobs
    set status = 'in_progress'
    where id = new.job_id
      and company_id = new.company_id
      and status = 'scheduled';
  elsif new.status = 'completed'
    and old.status is distinct from new.status
    and not exists (
      select 1
      from public.visits visit
      where visit.company_id = new.company_id
        and visit.job_id = new.job_id
        and visit.id <> new.id
        and visit.status not in ('completed', 'cancelled')
    )
  then
    update public.jobs
    set status = 'completed'
    where id = new.job_id
      and company_id = new.company_id
      and status in ('scheduled', 'in_progress');
  end if;
  return new;
end;
$$;

create trigger visits_sync_job_status
  after update of status on public.visits
  for each row
  when (old.status is distinct from new.status)
  execute function public.sync_storyops_job_from_visit();

create or replace function public.prepare_storyops_deposit_checkout(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_command_id uuid,
  p_quote_id uuid,
  p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_role public.app_role;
  request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  quote_row public.quotes%rowtype;
  estimate_row public.estimates%rowtype;
  job_row public.jobs%rowtype;
  invoice_row public.invoices%rowtype;
  payment_row public.payments%rowtype;
  result jsonb;
begin
  if p_actor_user_id is null
    or p_command_id is null
    or p_quote_id is null
    or p_expected_version < 1
  then
    raise exception 'GOLDEN_PATH_INVALID_CHECKOUT_REQUEST';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active;
  if actor_role is null then
    raise exception 'GOLDEN_PATH_MEMBERSHIP_REQUIRED';
  end if;

  select *
  into quote_row
  from public.quotes
  where id = p_quote_id
    and company_id = p_company_id
  for update;

  if not found or quote_row.version <> p_expected_version then
    raise exception 'GOLDEN_PATH_QUOTE_VERSION_CONFLICT';
  end if;
  if quote_row.valid_until < current_date then
    raise exception 'GOLDEN_PATH_QUOTE_EXPIRED';
  end if;
  if actor_role = 'customer'
    and not exists (
      select 1
      from public.customer_portal_users portal
      where portal.company_id = p_company_id
        and portal.user_id = p_actor_user_id
        and portal.customer_id = quote_row.customer_id
    )
  then
    raise exception 'GOLDEN_PATH_CUSTOMER_SCOPE_REQUIRED';
  elsif actor_role not in ('owner', 'dispatcher', 'customer') then
    raise exception 'GOLDEN_PATH_CHECKOUT_ROLE_REQUIRED';
  end if;

  perform public.assert_storyops_accepted_pricing(p_company_id, p_quote_id);

  request_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'action', 'deposit.checkout',
        'quoteId', p_quote_id,
        'expectedVersion', p_expected_version
      )::text,
      'sha256'
    ),
    'hex'
  );

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'deposit-checkout-v1',
    p_command_id::text,
    request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'deposit-checkout-v1'
      and key = p_command_id::text
    for update;
    if reservation.request_hash <> request_hash then
      raise exception 'GOLDEN_PATH_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return jsonb_build_object(
        'claimStatus', 'completed',
        'storedResponse', reservation.response
      );
    elsif reservation.status = 'in_progress'
      and reservation.locked_at >= now() - interval '5 minutes'
    then
      raise exception 'GOLDEN_PATH_CHECKOUT_IN_PROGRESS';
    end if;
    update public.idempotency_keys
    set
      status = 'in_progress',
      response = null,
      error_code = null,
      locked_at = now(),
      completed_at = null,
      expires_at = now() + interval '90 days'
    where id = reservation.id;
    reservation_id := reservation.id;
  end if;

  select *
  into estimate_row
  from public.estimates
  where id = quote_row.estimate_id
    and company_id = p_company_id;

  insert into public.jobs(
    company_id, job_number, quote_id, customer_id, property_id, status,
    priority, service_codes, estimated_duration_minutes, estimated_revenue,
    estimated_cost
  )
  values (
    p_company_id,
    'JOB-' || extract(year from now())::integer::text || '-'
      || upper(left(replace(p_quote_id::text, '-', ''), 8)),
    p_quote_id,
    quote_row.customer_id,
    quote_row.property_id,
    case when quote_row.deposit_required = 0
      then 'ready_to_schedule' else 'pending_deposit' end,
    'routine',
    array(
      select distinct line.service_code
      from public.estimate_lines line
      where line.company_id = p_company_id
        and line.estimate_id = estimate_row.id
        and line.service_code is not null
      order by line.service_code
    ),
    estimate_row.duration_minutes,
    estimate_row.total,
    estimate_row.estimated_cost
  )
  on conflict (company_id, quote_id) do nothing;

  select *
  into job_row
  from public.jobs
  where company_id = p_company_id
    and quote_id = p_quote_id
  for update;

  if job_row.customer_id <> quote_row.customer_id
    or job_row.property_id <> quote_row.property_id
    or job_row.estimated_revenue <> quote_row.total
  then
    raise exception 'GOLDEN_PATH_JOB_QUOTE_MISMATCH';
  end if;

  insert into public.invoices(
    company_id, invoice_number, customer_id, job_id, purpose, status,
    issue_date, due_date, subtotal, tax, total, amount_paid, balance_due
  )
  values (
    p_company_id,
    'INV-' || extract(year from now())::integer::text || '-'
      || upper(left(replace(job_row.id::text, '-', ''), 8)),
    quote_row.customer_id,
    job_row.id,
    'job',
    'draft',
    current_date,
    current_date,
    quote_row.total - estimate_row.tax,
    estimate_row.tax,
    quote_row.total,
    0,
    quote_row.total
  )
  on conflict (company_id, job_id, purpose)
    where job_id is not null
    do nothing;

  select *
  into invoice_row
  from public.invoices
  where company_id = p_company_id
    and job_id = job_row.id
    and purpose = 'job'
  for update;

  if invoice_row.customer_id <> quote_row.customer_id
    or invoice_row.total <> quote_row.total
    or invoice_row.tax <> estimate_row.tax
    or invoice_row.subtotal <> quote_row.total - estimate_row.tax
  then
    raise exception 'GOLDEN_PATH_INVOICE_QUOTE_MISMATCH';
  end if;

  insert into public.invoice_lines(
    company_id, invoice_id, job_id, description, quantity, unit_price,
    subtotal, taxable, sort_order, source_estimate_line_id, line_kind, unit
  )
  select
    p_company_id,
    invoice_row.id,
    job_row.id,
    line.description,
    line.quantity,
    line.unit_price * line.multiplier,
    line.subtotal,
    line.taxable,
    line.sort_order,
    line.id,
    line.line_kind,
    line.unit
  from public.estimate_lines line
  where line.company_id = p_company_id
    and line.estimate_id = estimate_row.id
  on conflict (invoice_id, source_estimate_line_id)
    where source_estimate_line_id is not null
    do nothing;

  if (
    select count(*)
    from public.invoice_lines line
    where line.invoice_id = invoice_row.id
      and line.source_estimate_line_id is not null
  ) <> (
    select count(*)
    from public.estimate_lines line
    where line.company_id = p_company_id
      and line.estimate_id = estimate_row.id
  ) then
    raise exception 'GOLDEN_PATH_INVOICE_LINE_COPY_FAILED';
  end if;

  if quote_row.deposit_required = 0 then
    result := jsonb_build_object(
      'action', 'deposit.checkout',
      'status', 'not_required',
      'mode', 'none',
      'quoteId', quote_row.id,
      'jobId', job_row.id,
      'invoiceId', invoice_row.id,
      'amount', '0.00',
      'currency', 'USD',
      'paymentVerified', false,
      'depositReady', true,
      'replayed', false
    );
    update public.idempotency_keys
    set status = 'completed', response = result, completed_at = now()
    where id = reservation_id
      and status = 'in_progress';
    return jsonb_build_object(
      'claimStatus', 'completed',
      'storedResponse', result
    );
  end if;

  insert into public.payments(
    company_id, invoice_id, customer_id, provider, payment_type, status,
    amount, idempotency_key
  )
  values (
    p_company_id,
    invoice_row.id,
    quote_row.customer_id,
    'stripe',
    'deposit',
    'pending',
    quote_row.deposit_required,
    'deposit:' || quote_row.id::text
  )
  on conflict (company_id, invoice_id)
    where payment_type = 'deposit'
    do nothing;

  select *
  into payment_row
  from public.payments
  where company_id = p_company_id
    and invoice_id = invoice_row.id
    and payment_type = 'deposit'
  for update;

  if payment_row.customer_id <> quote_row.customer_id
    or payment_row.provider <> 'stripe'
    or payment_row.amount <> quote_row.deposit_required
    or payment_row.status in ('refunded', 'partially_refunded')
  then
    raise exception 'GOLDEN_PATH_DEPOSIT_PAYMENT_MISMATCH';
  end if;

  if public.storyops_payment_has_provider_proof(payment_row.id, quote_row.id) then
    result := jsonb_build_object(
      'action', 'deposit.checkout',
      'status', 'already_verified',
      'mode', 'none',
      'quoteId', quote_row.id,
      'jobId', job_row.id,
      'invoiceId', invoice_row.id,
      'amount', quote_row.deposit_required::text,
      'currency', 'USD',
      'paymentVerified', true,
      'depositReady', true,
      'replayed', false
    );
    update public.idempotency_keys
    set status = 'completed', response = result, completed_at = now()
    where id = reservation_id
      and status = 'in_progress';
    return jsonb_build_object(
      'claimStatus', 'completed',
      'storedResponse', result
    );
  end if;

  return jsonb_build_object(
    'claimStatus', 'reserved',
    'requestHash', request_hash,
    'quoteId', quote_row.id,
    'customerId', quote_row.customer_id,
    'jobId', job_row.id,
    'invoiceId', invoice_row.id,
    'paymentId', payment_row.id,
    'amount', quote_row.deposit_required::text,
    'currency', 'USD',
    'description', 'Deposit for quote ' || quote_row.quote_number,
    'providerIdempotencyKey', 'storyops:deposit:' || quote_row.id::text
  );
end;
$$;

create or replace function public.complete_storyops_deposit_checkout(
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
set search_path = pg_catalog, public
as $$
begin
  if p_request_hash !~ '^[a-f0-9]{64}$'
    or p_provider_checkout_id !~ '^cs_'
    or jsonb_typeof(p_response) <> 'object'
    or p_response ->> 'paymentVerified' <> 'false'
    or p_response ->> 'depositReady' <> 'false'
    or p_response ->> 'status' <> 'checkout_open'
    or p_response ->> 'checkoutId' <> p_provider_checkout_id
  then
    raise exception 'GOLDEN_PATH_INVALID_CHECKOUT_RECEIPT';
  end if;

  update public.payments
  set
    provider_payment_id = p_provider_checkout_id,
    status = 'pending',
    processed_at = null,
    failure_code = null
  where id = p_payment_id
    and company_id = p_company_id
    and provider = 'stripe'
    and payment_type = 'deposit'
    and status in ('pending', 'failed')
    and (
      provider_payment_id is null
      or provider_payment_id = p_provider_checkout_id
    );
  if not found then
    raise exception 'GOLDEN_PATH_PAYMENT_CHECKOUT_CONFLICT';
  end if;

  update public.idempotency_keys
  set
    status = 'completed',
    response = p_response,
    error_code = null,
    completed_at = now()
  where company_id = p_company_id
    and scope = 'deposit-checkout-v1'
    and key = p_command_id::text
    and request_hash = p_request_hash
    and status = 'in_progress';
  if not found then
    raise exception 'GOLDEN_PATH_CHECKOUT_RESERVATION_LOST';
  end if;
end;
$$;

create or replace function public.fail_storyops_deposit_checkout(
  p_company_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.idempotency_keys
  set
    status = 'failed',
    error_code = left(
      regexp_replace(
        coalesce(nullif(btrim(p_error_code), ''), 'CHECKOUT_FAILED'),
        '[^A-Z0-9_]',
        '_',
        'g'
      ),
      120
    ),
    completed_at = now()
  where company_id = p_company_id
    and scope = 'deposit-checkout-v1'
    and key = p_command_id::text
    and request_hash = p_request_hash
    and status = 'in_progress';
end;
$$;

create or replace function public.execute_storyops_golden_path_command(
  p_company_id uuid,
  p_command_id uuid,
  p_command_type text,
  p_expected_version integer,
  p_payload jsonb,
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
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  unexpected_key text;
  job_row public.jobs%rowtype;
  quote_row public.quotes%rowtype;
  estimate_row public.estimates%rowtype;
  invoice_row public.invoices%rowtype;
  visit_row public.visits%rowtype;
  route_row public.route_checks%rowtype;
  weather_row public.weather_checks%rowtype;
  crew_row public.crews%rowtype;
  required_skills text[];
  required_equipment text[];
  checklist_template_id_value uuid;
  starts_at_value timestamptz;
  ends_at_value timestamptz;
  result_entity_id uuid;
  result_version integer;
  job_version_value integer;
  verified_deposit numeric(12,2) := 0;
  result jsonb;
begin
  if actor_user_id is null then
    raise exception 'GOLDEN_PATH_AUTHENTICATION_REQUIRED';
  end if;
  if p_command_type not in ('job.book', 'invoice.issue')
    or p_command_id is null
    or p_expected_version < 1
    or jsonb_typeof(p_payload) <> 'object'
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'GOLDEN_PATH_INVALID_COMMAND';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role not in ('owner', 'dispatcher') then
    raise exception 'GOLDEN_PATH_BACK_OFFICE_REQUIRED';
  end if;

  effective_request_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'commandType', p_command_type,
        'expectedVersion', p_expected_version,
        'payload', p_payload
      )::text,
      'sha256'
    ),
    'hex'
  );

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'golden-path-command-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'golden-path-command-v1'
      and key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'GOLDEN_PATH_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    else
      raise exception 'GOLDEN_PATH_COMMAND_IN_PROGRESS';
    end if;
  end if;

  if p_command_type = 'job.book' then
    select key
    into unexpected_key
    from jsonb_object_keys(p_payload) as keys(key)
    where key <> 'entityId'
    limit 1;
    if unexpected_key is not null then
      raise exception 'GOLDEN_PATH_UNSUPPORTED_BOOKING_FIELD';
    end if;

    select *
    into job_row
    from public.jobs
    where id = nullif(p_payload ->> 'entityId', '')::uuid
      and company_id = p_company_id
    for update;
    if not found
      or job_row.version <> p_expected_version
      or job_row.status not in ('pending_deposit', 'ready_to_schedule')
    then
      raise exception 'GOLDEN_PATH_JOB_NOT_BOOKABLE';
    end if;

    select *
    into quote_row
    from public.quotes
    where id = job_row.quote_id
      and company_id = p_company_id;
    perform public.assert_storyops_accepted_pricing(p_company_id, quote_row.id);
    select *
    into estimate_row
    from public.estimates
    where id = quote_row.estimate_id
      and company_id = p_company_id;

    select round(coalesce(sum(payment.amount), 0), 2)
    into verified_deposit
    from public.payments payment
    join public.invoices invoice on invoice.id = payment.invoice_id
    where invoice.company_id = p_company_id
      and invoice.job_id = job_row.id
      and invoice.purpose = 'job'
      and payment.payment_type = 'deposit'
      and public.storyops_payment_has_provider_proof(payment.id, quote_row.id);

    if quote_row.deposit_required > 0
      and verified_deposit < quote_row.deposit_required
    then
      raise exception 'GOLDEN_PATH_VERIFIED_DEPOSIT_REQUIRED';
    end if;

    select *
    into route_row
    from public.route_checks route
    where route.company_id = p_company_id
      and route.checked_at >= now() - interval '30 minutes'
      and route.route_feasible
      and cardinality(route.violations) = 0
      and (
        route.request_payload ->> 'jobId' = job_row.id::text
        or (
          jsonb_typeof(route.request_payload -> 'jobIds') = 'array'
          and route.request_payload -> 'jobIds' ? job_row.id::text
        )
      )
    order by route.checked_at desc, route.id
    limit 1;
    if not found then
      raise exception 'GOLDEN_PATH_FRESH_ROUTE_REQUIRED';
    end if;

    select *
    into weather_row
    from public.weather_checks weather
    where weather.company_id = p_company_id
      and weather.property_id = job_row.property_id
      and weather.checked_at >= now() - interval '60 minutes'
      and weather.forecast_issued_at >= now() - interval '6 hours'
      and weather.policy_disposition = 'eligible'
      and weather.period_ends_at
        >= greatest(weather.period_starts_at, now() + interval '30 minutes')
          + make_interval(mins => estimate_row.duration_minutes)
    order by weather.period_starts_at, weather.checked_at desc, weather.id
    limit 1;
    if not found then
      raise exception 'GOLDEN_PATH_FRESH_ELIGIBLE_WEATHER_REQUIRED';
    end if;

    starts_at_value := greatest(
      weather_row.period_starts_at,
      date_trunc('minute', now() + interval '30 minutes')
    );
    ends_at_value := starts_at_value
      + make_interval(mins => estimate_row.duration_minutes);

    select coalesce(array_agg(distinct skill order by skill), '{}')
    into required_skills
    from public.service_catalog catalog
    cross join unnest(catalog.required_skills) skill
    where catalog.company_id = p_company_id
      and catalog.active
      and catalog.code = any(job_row.service_codes);

    select coalesce(array_agg(distinct equipment_type order by equipment_type), '{}')
    into required_equipment
    from public.service_catalog catalog
    cross join unnest(catalog.required_equipment_types) equipment_type
    where catalog.company_id = p_company_id
      and catalog.active
      and catalog.code = any(job_row.service_codes);

    if (
      select count(distinct catalog.code)
      from public.service_catalog catalog
      where catalog.company_id = p_company_id
        and catalog.active
        and catalog.code = any(job_row.service_codes)
    ) <> cardinality(job_row.service_codes)
    then
      raise exception 'GOLDEN_PATH_ACTIVE_SERVICE_CATALOG_REQUIRED';
    end if;

    select min(catalog.default_checklist_template_id::text)::uuid
    into checklist_template_id_value
    from public.service_catalog catalog
    where catalog.company_id = p_company_id
      and catalog.active
      and catalog.code = any(job_row.service_codes)
    having count(distinct catalog.default_checklist_template_id) = 1
      and bool_and(catalog.default_checklist_template_id is not null);
    if checklist_template_id_value is null then
      raise exception 'GOLDEN_PATH_SINGLE_CHECKLIST_REQUIRED';
    end if;

    select *
    into crew_row
    from public.crews crew
    where crew.company_id = p_company_id
      and crew.active
      and required_skills <@ crew.skill_codes
      and exists (
        select 1
        from public.crew_members member
        where member.company_id = p_company_id
          and member.crew_id = crew.id
          and member.starts_on <= ends_at_value::date
          and (member.ends_on is null or member.ends_on >= starts_at_value::date)
      )
      and not exists (
        select 1
        from unnest(required_equipment) needed(equipment_type)
        where not exists (
          select 1
          from public.equipment equipment
          where equipment.company_id = p_company_id
            and equipment.equipment_type = needed.equipment_type
            and equipment.status in ('available', 'assigned')
            and (
              equipment.assigned_crew_id is null
              or equipment.assigned_crew_id = crew.id
            )
            and (
              equipment.next_inspection_due is null
              or equipment.next_inspection_due >= starts_at_value::date
            )
        )
      )
      and not exists (
        select 1
        from public.visits visit
        where visit.company_id = p_company_id
          and visit.crew_id = crew.id
          and visit.status <> 'cancelled'
          and visit.starts_at < ends_at_value
          and visit.ends_at > starts_at_value
      )
    order by crew.id
    limit 1;
    if not found then
      raise exception 'GOLDEN_PATH_CREW_CAPACITY_UNAVAILABLE';
    end if;

    insert into public.visits(
      company_id, job_id, sequence, status, starts_at, ends_at, crew_id,
      route_check_id, weather_check_id, checklist_template_id
    )
    values (
      p_company_id, job_row.id, 1, 'confirmed', starts_at_value, ends_at_value,
      crew_row.id, route_row.id, weather_row.id, checklist_template_id_value
    )
    returning * into visit_row;

    insert into public.dispatch_assignments(
      company_id, visit_id, crew_id, assigned_by, starts_at, ends_at,
      route_position, status
    )
    values (
      p_company_id, visit_row.id, crew_row.id, actor_user_id,
      starts_at_value, ends_at_value, 0, 'confirmed'
    );

    insert into public.visit_checklist_items(
      company_id, visit_id, template_item_id, status
    )
    select p_company_id, visit_row.id, item.id, 'pending'
    from public.checklist_template_items item
    where item.company_id = p_company_id
      and item.template_id = checklist_template_id_value
    order by item.sort_order;

    update public.jobs
    set
      status = 'scheduled',
      assigned_crew_id = crew_row.id
    where id = job_row.id
      and company_id = p_company_id
      and version = p_expected_version
      and status in ('pending_deposit', 'ready_to_schedule')
    returning version into job_version_value;
    if not found then
      raise exception 'GOLDEN_PATH_JOB_VERSION_CONFLICT';
    end if;

    result_entity_id := visit_row.id;
    result_version := visit_row.version;
    result := jsonb_build_object(
      'commandId', p_command_id,
      'commandType', p_command_type,
      'status', 'applied',
      'replayed', false,
      'entityId', result_entity_id,
      'version', result_version,
      'jobId', job_row.id,
      'jobVersion', job_version_value,
      'startsAt', starts_at_value,
      'endsAt', ends_at_value,
      'crewId', crew_row.id,
      'routeCheckId', route_row.id,
      'weatherCheckId', weather_row.id,
      'requestHash', effective_request_hash,
      'serverTime', now()
    );
  else
    select key
    into unexpected_key
    from jsonb_object_keys(p_payload) as keys(key)
    where key <> all(array[
      'entityId', 'invoiceId', 'invoiceVersion', 'visitId', 'visitVersion'
    ]::text[])
    limit 1;
    if unexpected_key is not null then
      raise exception 'GOLDEN_PATH_UNSUPPORTED_INVOICE_FIELD';
    end if;
    if coalesce(p_payload ->> 'invoiceVersion', '') !~ '^[1-9][0-9]*$'
      or coalesce(p_payload ->> 'visitVersion', '') !~ '^[1-9][0-9]*$'
    then
      raise exception 'GOLDEN_PATH_INVOICE_VERSIONS_REQUIRED';
    end if;

    select *
    into job_row
    from public.jobs
    where id = nullif(p_payload ->> 'entityId', '')::uuid
      and company_id = p_company_id
    for update;
    if not found
      or job_row.version <> p_expected_version
      or job_row.status <> 'completed'
    then
      raise exception 'GOLDEN_PATH_COMPLETED_JOB_REQUIRED';
    end if;

    select *
    into quote_row
    from public.quotes
    where id = job_row.quote_id
      and company_id = p_company_id;
    perform public.assert_storyops_accepted_pricing(p_company_id, quote_row.id);
    select *
    into estimate_row
    from public.estimates
    where id = quote_row.estimate_id
      and company_id = p_company_id;

    select *
    into visit_row
    from public.visits
    where id = nullif(p_payload ->> 'visitId', '')::uuid
      and company_id = p_company_id
      and job_id = job_row.id
    for update;
    if not found
      or visit_row.version <> (p_payload ->> 'visitVersion')::integer
      or visit_row.status <> 'completed'
      or exists (
        select 1
        from public.visits other
        where other.company_id = p_company_id
          and other.job_id = job_row.id
          and other.status not in ('completed', 'cancelled')
      )
      or exists (
        select 1
        from public.incidents incident
        where incident.company_id = p_company_id
          and incident.job_id = job_row.id
          and incident.status <> 'closed'
      )
    then
      raise exception 'GOLDEN_PATH_COMPLETION_PACKET_REQUIRED';
    end if;

    select *
    into invoice_row
    from public.invoices
    where id = nullif(p_payload ->> 'invoiceId', '')::uuid
      and company_id = p_company_id
      and job_id = job_row.id
      and purpose = 'job'
    for update;
    if not found
      or invoice_row.version <> (p_payload ->> 'invoiceVersion')::integer
      or invoice_row.status <> 'draft'
      or invoice_row.total <> quote_row.total
      or invoice_row.tax <> estimate_row.tax
      or invoice_row.subtotal <> quote_row.total - estimate_row.tax
    then
      raise exception 'GOLDEN_PATH_DRAFT_INVOICE_REQUIRED';
    end if;

    if exists (
      select 1
      from public.estimate_lines estimate_line
      where estimate_line.company_id = p_company_id
        and estimate_line.estimate_id = estimate_row.id
        and not exists (
          select 1
          from public.invoice_lines invoice_line
          where invoice_line.invoice_id = invoice_row.id
            and invoice_line.source_estimate_line_id = estimate_line.id
            and invoice_line.description = estimate_line.description
            and invoice_line.quantity = estimate_line.quantity
            and invoice_line.unit_price
              = estimate_line.unit_price * estimate_line.multiplier
            and invoice_line.subtotal = estimate_line.subtotal
            and invoice_line.taxable = estimate_line.taxable
            and invoice_line.sort_order = estimate_line.sort_order
            and invoice_line.line_kind = estimate_line.line_kind
            and invoice_line.unit = estimate_line.unit
        )
    ) or (
      select count(*)
      from public.invoice_lines line
      where line.invoice_id = invoice_row.id
    ) <> (
      select count(*)
      from public.estimate_lines line
      where line.company_id = p_company_id
        and line.estimate_id = estimate_row.id
    )
    then
      raise exception 'GOLDEN_PATH_INVOICE_LINES_NOT_AUTHORITATIVE';
    end if;

    select round(coalesce(sum(payment.amount), 0), 2)
    into verified_deposit
    from public.payments payment
    where payment.company_id = p_company_id
      and payment.invoice_id = invoice_row.id
      and payment.payment_type = 'deposit'
      and public.storyops_payment_has_provider_proof(payment.id, quote_row.id);

    if verified_deposit > quote_row.total
      or (
        quote_row.deposit_required > 0
        and verified_deposit < quote_row.deposit_required
      )
    then
      raise exception 'GOLDEN_PATH_VERIFIED_DEPOSIT_MISMATCH';
    end if;

    update public.invoices
    set
      status = case
        when verified_deposit >= total then 'paid'
        else 'open'
      end,
      issue_date = current_date,
      due_date = current_date,
      amount_paid = least(total, verified_deposit),
      balance_due = greatest(0, total - least(total, verified_deposit)),
      paid_at = case
        when verified_deposit >= total then now()
        else null
      end
    where id = invoice_row.id
      and version = (p_payload ->> 'invoiceVersion')::integer
    returning * into invoice_row;
    if not found then
      raise exception 'GOLDEN_PATH_INVOICE_VERSION_CONFLICT';
    end if;

    update public.jobs
    set status = 'invoiced'
    where id = job_row.id
      and version = p_expected_version
      and status = 'completed'
    returning version into job_version_value;
    if not found then
      raise exception 'GOLDEN_PATH_JOB_VERSION_CONFLICT';
    end if;

    result_entity_id := invoice_row.id;
    result_version := invoice_row.version;
    result := jsonb_build_object(
      'commandId', p_command_id,
      'commandType', p_command_type,
      'status', 'applied',
      'replayed', false,
      'entityId', result_entity_id,
      'version', result_version,
      'jobId', job_row.id,
      'jobVersion', job_version_value,
      'visitId', visit_row.id,
      'visitVersion', visit_row.version,
      'total', invoice_row.total::text,
      'amountPaid', invoice_row.amount_paid::text,
      'balanceDue', invoice_row.balance_due::text,
      'requestHash', effective_request_hash,
      'serverTime', now()
    );
  end if;

  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = reservation_id
    and status = 'in_progress';
  if not found then
    raise exception 'GOLDEN_PATH_COMMAND_RESERVATION_LOST';
  end if;
  return result;
end;
$$;

revoke all on function public.assert_storyops_accepted_pricing(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.storyops_payment_has_provider_proof(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.refresh_storyops_deposit_state(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prepare_storyops_deposit_checkout(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.complete_storyops_deposit_checkout(
  uuid, uuid, text, uuid, text, jsonb
) from public, anon, authenticated;
revoke all on function public.fail_storyops_deposit_checkout(
  uuid, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.execute_storyops_golden_path_command(
  uuid, uuid, text, integer, jsonb, text
) from public, anon;

grant execute on function public.prepare_storyops_deposit_checkout(
  uuid, uuid, uuid, uuid, integer
) to service_role;
grant execute on function public.complete_storyops_deposit_checkout(
  uuid, uuid, text, uuid, text, jsonb
) to service_role;
grant execute on function public.fail_storyops_deposit_checkout(
  uuid, uuid, text, text
) to service_role;
grant execute on function public.execute_storyops_golden_path_command(
  uuid, uuid, text, integer, jsonb, text
) to authenticated;

comment on function public.prepare_storyops_deposit_checkout(
  uuid, uuid, uuid, uuid, integer
) is
  'Atomically validates accepted deterministic pricing and prepares one pending deposit checkout without asserting payment success.';

comment on function public.execute_storyops_golden_path_command(
  uuid, uuid, text, integer, jsonb, text
) is
  'Finite authenticated booking/invoice commands with payment proof, capacity, weather, route, completion, RBAC, and optimistic-version enforcement.';
