-- Stripe payment truth boundary.
--
-- A Checkout Session (cs_*) is not a PaymentIntent (pi_*). Keep both exact
-- provider identities, reconcile signed payment events with invoice-first lock
-- ordering, and quarantine verified money that cannot be allocated exactly.

alter table public.payments
  add column provider_checkout_id text,
  add column provider_amount_received numeric(12,2),
  add column allocation_status text,
  add column checkout_attempt integer not null default 1;

alter table public.payments
  add constraint payments_provider_checkout_id_format check (
    provider_checkout_id is null
    or (
      provider_checkout_id ~ '^cs_[A-Za-z0-9_]+$'
      and length(provider_checkout_id) <= 255
    )
  ),
  add constraint payments_provider_amount_received_check check (
    provider_amount_received is null or provider_amount_received > 0
  ),
  add constraint payments_allocation_status_check check (
    allocation_status is null
    or allocation_status in ('applied', 'unapplied')
  ),
  add constraint payments_checkout_attempt_check check (
    checkout_attempt > 0
  );

-- Pre-production repair: earlier checkout completion stored cs_* in the
-- PaymentIntent field. A cs_* value is publication of a checkout only.
update public.payments
set provider_checkout_id = provider_payment_id,
    provider_payment_id = null
where provider = 'stripe'
  and provider_payment_id like 'cs\_%' escape '\';

update public.payments payment
set provider_amount_received = amount,
    allocation_status = 'applied'
where provider = 'stripe'
  and payment_type <> 'refund'
  and status in ('succeeded', 'partially_refunded', 'refunded')
  and provider_payment_id like 'pi\_%' escape '\'
  and exists (
    select 1
    from public.webhook_events event
    where event.company_id = payment.company_id
      and event.provider = 'stripe'
      and event.status = 'processed'
      and event.payload ->> 'action' = 'payment_succeeded'
      and event.payload ->> 'amountCents' ~ '^[0-9]+$'
      and (event.payload ->> 'amountCents')::bigint
        = round(payment.amount * 100)::bigint
      and (
        event.payload ->> 'objectId' = payment.provider_payment_id
        or event.payload ->> 'paymentIntentId' = payment.provider_payment_id
      )
  );

do $$
begin
  if exists (
    select 1
    from public.payments payment
    where payment.provider = 'stripe'
      and payment.payment_type <> 'refund'
      and payment.status in ('succeeded', 'partially_refunded', 'refunded')
      and (
        payment.provider_payment_id is null
        or payment.provider_payment_id !~ '^pi_[A-Za-z0-9_]+$'
        or payment.provider_amount_received is null
        or payment.allocation_status is distinct from 'applied'
      )
  ) then
    raise exception using message =
      'STRIPE_SUCCEEDED_PAYMENT_PROVIDER_PROOF_REQUIRED';
  end if;
end;
$$;

alter table public.payments
  add constraint payments_stripe_allocation_truth_check check (
    (
      provider <> 'stripe'
      or payment_type = 'refund'
      or status not in ('succeeded', 'partially_refunded', 'refunded')
      or (
        provider_payment_id is not null
        and provider_payment_id ~ '^pi_[A-Za-z0-9_]+$'
        and provider_amount_received is not null
        and allocation_status is not null
        and allocation_status in ('applied', 'unapplied')
      )
    )
    and (
      allocation_status is null
      or (
        provider = 'stripe'
        and payment_type <> 'refund'
        and provider_amount_received is not null
        and provider_payment_id is not null
        and provider_payment_id ~ '^pi_[A-Za-z0-9_]+$'
      )
    )
    and (
      allocation_status is distinct from 'applied'
      or provider_amount_received = amount
    )
  );

create unique index payments_provider_checkout_once_idx
  on public.payments(company_id, provider, provider_checkout_id)
  where provider_checkout_id is not null;

-- V1 collects one exact invoice balance. A version change must not manufacture
-- a second externally chargeable session for the same invoice.
do $$
begin
  if exists (
    select 1
    from public.payments payment
    where payment.provider = 'stripe'
      and payment.payment_type = 'invoice'
    group by payment.company_id, payment.invoice_id
    having count(*) > 1
  ) then
    raise exception using message = 'DUPLICATE_INVOICE_CHECKOUTS_REQUIRE_RECONCILIATION';
  end if;
end;
$$;

create unique index payments_one_stripe_invoice_checkout_idx
  on public.payments(company_id, invoice_id)
  where provider = 'stripe' and payment_type = 'invoice';

create table public.payment_allocation_conflicts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  provider_event_id uuid not null references public.webhook_events(id) on delete restrict,
  conflict_code text not null check (
    conflict_code in (
      'stale_invoice_version',
      'invoice_not_payable',
      'provider_overpayment',
      'provider_underpayment',
      'local_payment_amount_mismatch',
      'retired_checkout_succeeded'
    )
  ),
  intended_amount numeric(12,2) not null check (intended_amount > 0),
  verified_amount numeric(12,2) not null check (verified_amount > 0),
  invoice_balance_at_event numeric(12,2) not null check (invoice_balance_at_event >= 0),
  provider_checkout_id text,
  provider_payment_id text not null check (
    provider_payment_id ~ '^pi_[A-Za-z0-9_]+$'
    and length(provider_payment_id) <= 255
  ),
  provider_occurred_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  approval_request_id uuid references public.approval_requests(id) on delete restrict,
  resolution_note text check (
    resolution_note is null or char_length(resolution_note) <= 2000
  ),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  retention_class text not null default 'financial',
  retain_until timestamptz not null default (now() + interval '7 years'),
  legal_hold boolean not null default false,
  unique (company_id, provider_event_id),
  check (
    provider_checkout_id is null
    or (
      provider_checkout_id ~ '^cs_[A-Za-z0-9_]+$'
      and length(provider_checkout_id) <= 255
    )
  ),
  check (retain_until > created_at),
  check (
    (status = 'open' and resolved_by is null and resolved_at is null)
    or (
      status = 'resolved'
      and resolved_by is not null
      and resolved_at is not null
      and nullif(btrim(resolution_note), '') is not null
    )
  )
);

create unique index payment_allocation_conflicts_one_open_payment_idx
  on public.payment_allocation_conflicts(company_id, payment_id)
  where status = 'open';

create index payment_allocation_conflicts_owner_queue_idx
  on public.payment_allocation_conflicts(company_id, status, created_at)
  where status = 'open';

-- A provider-confirmed terminal Checkout Session is immutable evidence. Retire
-- that exact cs_* before issuing a replacement attempt; never erase the
-- provider history or silently reuse Stripe's idempotency key.
create table public.payment_checkout_retirements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete restrict,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  provider_event_id uuid not null references public.webhook_events(id) on delete restrict,
  provider_checkout_id text not null check (
    provider_checkout_id ~ '^cs_[A-Za-z0-9_]+$'
    and length(provider_checkout_id) <= 255
  ),
  provider_payment_id text check (
    provider_payment_id is null
    or (
      provider_payment_id ~ '^pi_[A-Za-z0-9_]+$'
      and length(provider_payment_id) <= 255
    )
  ),
  checkout_attempt integer not null check (checkout_attempt > 0),
  retirement_reason text not null check (
    retirement_reason in (
      'checkout_session_expired',
      'checkout_async_payment_failed'
    )
  ),
  provider_occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  retention_class text not null default 'financial',
  retain_until timestamptz not null default (now() + interval '7 years'),
  legal_hold boolean not null default false,
  unique (company_id, provider_event_id),
  unique (company_id, provider_checkout_id),
  unique (company_id, payment_id, checkout_attempt),
  check (retain_until > created_at)
);

create index payment_checkout_retirements_payment_idx
  on public.payment_checkout_retirements(company_id, payment_id, checkout_attempt);

create unique index payment_checkout_retirements_payment_intent_once_idx
  on public.payment_checkout_retirements(company_id, provider_payment_id)
  where provider_payment_id is not null;

alter table public.payment_allocation_conflicts enable row level security;
alter table public.payment_allocation_conflicts force row level security;
revoke all on table public.payment_allocation_conflicts
  from public, anon, authenticated, service_role;

alter table public.payment_checkout_retirements enable row level security;
alter table public.payment_checkout_retirements force row level security;
revoke all on table public.payment_checkout_retirements
  from public, anon, authenticated, service_role;

create trigger payment_allocation_conflicts_touch
  before update on public.payment_allocation_conflicts
  for each row execute function public.touch_record();

create or replace function private.record_storyops_payment_allocation_conflict(
  p_company_id uuid,
  p_payment_id uuid,
  p_invoice_id uuid,
  p_provider_event_id uuid,
  p_conflict_code text,
  p_intended_amount numeric,
  p_verified_amount numeric,
  p_invoice_balance numeric,
  p_provider_checkout_id text,
  p_provider_payment_id text,
  p_provider_occurred_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions, auth
as $$
declare
  conflict_row public.payment_allocation_conflicts%rowtype;
  approval_id_value uuid;
  exact_payload jsonb;
  payload_hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'EDGE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_conflict_code not in (
      'stale_invoice_version',
      'invoice_not_payable',
      'provider_overpayment',
      'provider_underpayment',
      'local_payment_amount_mismatch',
      'retired_checkout_succeeded'
    )
    or p_intended_amount <= 0
    or p_verified_amount <= 0
    or p_invoice_balance < 0
    or p_provider_payment_id !~ '^pi_[A-Za-z0-9_]+$'
    or (
      p_provider_checkout_id is not null
      and p_provider_checkout_id !~ '^cs_[A-Za-z0-9_]+$'
    )
  then
    raise exception using message = 'PAYMENT_ALLOCATION_CONFLICT_INVALID';
  end if;
  if not exists (
    select 1
    from public.payments payment
    join public.invoices invoice
      on invoice.id = payment.invoice_id
     and invoice.company_id = payment.company_id
    where payment.company_id = p_company_id
      and payment.id = p_payment_id
      and payment.invoice_id = p_invoice_id
  ) then
    raise exception using message = 'PAYMENT_ALLOCATION_CONFLICT_SCOPE_INVALID';
  end if;

  insert into public.payment_allocation_conflicts(
    company_id, payment_id, invoice_id, provider_event_id, conflict_code,
    intended_amount, verified_amount, invoice_balance_at_event,
    provider_checkout_id, provider_payment_id, provider_occurred_at
  )
  values (
    p_company_id, p_payment_id, p_invoice_id, p_provider_event_id, p_conflict_code,
    p_intended_amount, p_verified_amount, p_invoice_balance,
    p_provider_checkout_id, p_provider_payment_id, p_provider_occurred_at
  )
  on conflict do nothing;

  select *
  into conflict_row
  from public.payment_allocation_conflicts conflict
  where conflict.company_id = p_company_id
    and (
      conflict.provider_event_id = p_provider_event_id
      or (conflict.payment_id = p_payment_id and conflict.status = 'open')
    )
  order by
    (conflict.provider_event_id = p_provider_event_id) desc,
    conflict.created_at
  limit 1
  for update;

  if not found
    or conflict_row.payment_id <> p_payment_id
    or conflict_row.invoice_id <> p_invoice_id
    or conflict_row.status <> 'open'
  then
    raise exception using message = 'PAYMENT_ALLOCATION_CONFLICT_RESERVATION_LOST';
  end if;

  if conflict_row.approval_request_id is null then
    exact_payload := jsonb_build_object(
      'conflictId', conflict_row.id,
      'paymentId', conflict_row.payment_id,
      'invoiceId', conflict_row.invoice_id,
      'providerEventId', conflict_row.provider_event_id,
      'conflictCode', conflict_row.conflict_code,
      'intendedAmount', conflict_row.intended_amount::text,
      'verifiedAmount', conflict_row.verified_amount::text,
      'invoiceBalanceAtEvent', conflict_row.invoice_balance_at_event::text,
      'providerCheckoutId', conflict_row.provider_checkout_id,
      'providerPaymentId', conflict_row.provider_payment_id
    );
    payload_hash := encode(
      extensions.digest(convert_to(exact_payload::text, 'UTF8'), 'sha256'),
      'hex'
    );
    insert into public.approval_requests(
      company_id, reason, risk_level, requested_by_type, requested_by_id,
      entity_type, entity_id, action_type, action_payload, summary, policy_version
    )
    values (
      p_company_id,
      'other',
      'high',
      'provider',
      'stripe',
      'payment_allocation_conflict',
      conflict_row.id,
      case
        when conflict_row.conflict_code = 'stale_invoice_version'
          and conflict_row.intended_amount = conflict_row.verified_amount
          and conflict_row.verified_amount = conflict_row.invoice_balance_at_event
        then 'payment.allocation.apply_exact_current_balance'
        else 'payment.allocation.review_manual'
      end,
      jsonb_build_object(
        'schemaVersion', 'storyops-payment-allocation-conflict-v1',
        'payloadHash', payload_hash,
        'exactPayload', exact_payload
      ),
      case
        when conflict_row.conflict_code = 'stale_invoice_version'
          and conflict_row.intended_amount = conflict_row.verified_amount
          and conflict_row.verified_amount = conflict_row.invoice_balance_at_event
        then 'Verified Stripe funds exactly match the current invoice balance but require an owner-approved ledger application.'
        else 'Verified Stripe funds do not qualify for automatic ledger application. Collection remains on hold for manual Stripe and accounting review.'
      end,
      'payment-allocation-conflict-v1'
    )
    returning id into approval_id_value;

    update public.payment_allocation_conflicts
    set approval_request_id = approval_id_value
    where id = conflict_row.id
      and approval_request_id is null;
  end if;

  return conflict_row.id;
end;
$$;

revoke all on function private.record_storyops_payment_allocation_conflict(
  uuid, uuid, uuid, uuid, text, numeric, numeric, numeric, text, text, timestamptz
) from public, anon, authenticated, service_role;

-- The only automated resolution V1 permits is applying already-verified funds
-- when the provider amount, local payment amount, and current invoice balance
-- are still exactly equal. Over/under-payments and retired-session successes
-- remain non-executable manual-review holds.
create or replace function public.resolve_storyops_payment_allocation(
  p_company_id uuid,
  p_conflict_id uuid,
  p_approval_request_id uuid,
  p_expected_conflict_version integer,
  p_expected_invoice_version integer,
  p_resolution_note text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  conflict_probe public.payment_allocation_conflicts%rowtype;
  conflict_row public.payment_allocation_conflicts%rowtype;
  payment_row public.payments%rowtype;
  invoice_row public.invoices%rowtype;
  exact_payload jsonb;
  approval_replay jsonb;
  resolution_note_hash text;
  execution_time timestamptz := clock_timestamp();
  result jsonb;
begin
  if actor_user_id is null
    or not public.has_company_role(
      p_company_id,
      array['owner']::public.app_role[]
    )
  then
    raise exception using message = 'PAYMENT_ALLOCATION_OWNER_REQUIRED';
  end if;
  if p_conflict_id is null
    or p_approval_request_id is null
    or p_expected_conflict_version < 1
    or p_expected_invoice_version < 1
    or nullif(btrim(p_resolution_note), '') is null
    or char_length(btrim(p_resolution_note)) not between 5 and 2000
  then
    raise exception using message = 'PAYMENT_ALLOCATION_RESOLUTION_INVALID';
  end if;
  resolution_note_hash := encode(
    extensions.digest(
      convert_to(btrim(p_resolution_note), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  select approval.execution_receipt
  into approval_replay
  from public.approval_requests approval
  where approval.company_id = p_company_id
    and approval.id = p_approval_request_id
    and approval.entity_type = 'payment_allocation_conflict'
    and approval.entity_id = p_conflict_id
    and approval.action_type =
      'payment.allocation.apply_exact_current_balance'
    and approval.status = 'approved'
    and approval.consumed_at is not null;
  if found then
    if approval_replay ->> 'schemaVersion'
        <> 'storyops-payment-allocation-resolution-v1'
      or approval_replay ->> 'companyId' <> p_company_id::text
      or approval_replay ->> 'conflictId' <> p_conflict_id::text
      or approval_replay ->> 'approvalRequestId'
        <> p_approval_request_id::text
      or (approval_replay ->> 'conflictVersion')::integer
        <> p_expected_conflict_version + 1
      or (approval_replay ->> 'invoiceVersion')::integer
        <> p_expected_invoice_version + 1
      or approval_replay ->> 'resolutionNoteHash'
        <> resolution_note_hash
    then
      raise exception using message =
        'PAYMENT_ALLOCATION_RESOLUTION_IDEMPOTENCY_CONFLICT';
    end if;
    return approval_replay - array[
      'disposition',
      'executedBy',
      'executedAt',
      'resolutionNoteHash'
    ];
  end if;

  select *
  into conflict_probe
  from public.payment_allocation_conflicts conflict
  where conflict.company_id = p_company_id
    and conflict.id = p_conflict_id;
  if not found then
    raise exception using message = 'PAYMENT_ALLOCATION_CONFLICT_NOT_FOUND';
  end if;

  -- Canonical finance lock order: invoice -> payment -> conflict -> approval.
  select *
  into invoice_row
  from public.invoices invoice
  where invoice.company_id = p_company_id
    and invoice.id = conflict_probe.invoice_id
  for update;
  if not found then
    raise exception using message = 'PAYMENT_ALLOCATION_INVOICE_NOT_FOUND';
  end if;
  select *
  into payment_row
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.id = conflict_probe.payment_id
  for update;
  if not found then
    raise exception using message = 'PAYMENT_ALLOCATION_PAYMENT_NOT_FOUND';
  end if;
  select *
  into conflict_row
  from public.payment_allocation_conflicts conflict
  where conflict.company_id = p_company_id
    and conflict.id = p_conflict_id
  for update;

  if not found
    or conflict_row.version <> p_expected_conflict_version
    or conflict_row.status <> 'open'
    or conflict_row.approval_request_id <> p_approval_request_id
    or conflict_row.payment_id <> payment_row.id
    or conflict_row.invoice_id <> invoice_row.id
    or conflict_row.conflict_code <> 'stale_invoice_version'
    or conflict_row.intended_amount <> conflict_row.verified_amount
    or conflict_row.verified_amount <> conflict_row.invoice_balance_at_event
    or payment_row.payment_type <> 'invoice'
    or payment_row.provider <> 'stripe'
    or payment_row.status <> 'succeeded'
    or payment_row.allocation_status <> 'unapplied'
    or payment_row.amount <> conflict_row.verified_amount
    or payment_row.provider_amount_received <> conflict_row.verified_amount
    or payment_row.provider_payment_id <> conflict_row.provider_payment_id
    or payment_row.provider_checkout_id
      is distinct from conflict_row.provider_checkout_id
    or invoice_row.version <> p_expected_invoice_version
    or invoice_row.status not in ('open', 'past_due')
    or invoice_row.total <> invoice_row.amount_paid + invoice_row.balance_due
    or invoice_row.balance_due <> conflict_row.verified_amount
  then
    raise exception using message =
      'PAYMENT_ALLOCATION_EXACT_APPLICATION_NOT_ALLOWED';
  end if;

  exact_payload := jsonb_build_object(
    'conflictId', conflict_row.id,
    'paymentId', conflict_row.payment_id,
    'invoiceId', conflict_row.invoice_id,
    'providerEventId', conflict_row.provider_event_id,
    'conflictCode', conflict_row.conflict_code,
    'intendedAmount', conflict_row.intended_amount::text,
    'verifiedAmount', conflict_row.verified_amount::text,
    'invoiceBalanceAtEvent', conflict_row.invoice_balance_at_event::text,
    'providerCheckoutId', conflict_row.provider_checkout_id,
    'providerPaymentId', conflict_row.provider_payment_id
  );
  result := jsonb_build_object(
    'schemaVersion', 'storyops-payment-allocation-resolution-v1',
    'status', 'applied',
    'companyId', p_company_id,
    'conflictId', conflict_row.id,
    'conflictVersion', conflict_row.version + 1,
    'paymentId', payment_row.id,
    'paymentVersion', payment_row.version + 1,
    'invoiceId', invoice_row.id,
    'invoiceVersion', invoice_row.version + 1,
    'approvalRequestId', p_approval_request_id,
    'amount', conflict_row.verified_amount::text,
    'serverTime', execution_time
  );
  perform public.consume_exact_action_approval(
    p_company_id,
    p_approval_request_id,
    'other',
    'payment.allocation.apply_exact_current_balance',
    'payment_allocation_conflict',
    conflict_row.id,
    exact_payload,
    result || jsonb_build_object(
      'disposition', 'applied_exact_current_balance',
      'executedBy', actor_user_id,
      'executedAt', execution_time,
      'resolutionNoteHash', resolution_note_hash
    )
  );

  update public.payments
  set allocation_status = 'applied'
  where id = payment_row.id
    and company_id = p_company_id
    and version = payment_row.version
    and allocation_status = 'unapplied';
  if not found then
    raise exception using message = 'PAYMENT_ALLOCATION_PAYMENT_VERSION_CONFLICT';
  end if;

  update public.invoices
  set amount_paid = amount_paid + conflict_row.verified_amount,
      balance_due = balance_due - conflict_row.verified_amount,
      status = 'paid',
      paid_at = coalesce(paid_at, conflict_row.provider_occurred_at)
  where id = invoice_row.id
    and company_id = p_company_id
    and version = invoice_row.version
    and balance_due = conflict_row.verified_amount;
  if not found then
    raise exception using message = 'PAYMENT_ALLOCATION_INVOICE_VERSION_CONFLICT';
  end if;

  update public.payment_allocation_conflicts
  set status = 'resolved',
      resolution_note = btrim(p_resolution_note),
      resolved_by = actor_user_id,
      resolved_at = now()
  where id = conflict_row.id
    and company_id = p_company_id
    and version = conflict_row.version
    and status = 'open';
  if not found then
    raise exception using message = 'PAYMENT_ALLOCATION_CONFLICT_VERSION_CONFLICT';
  end if;

  insert into public.audit_events(
    company_id, occurred_at, actor_type, actor_id, action,
    entity_type, entity_id, before_data, after_data, request_id,
    retention_class, retain_until
  )
  values (
    p_company_id,
    now(),
    'user',
    actor_user_id::text,
    'payment_allocation_applied_exact_current_balance',
    'payment_allocation_conflict',
    conflict_row.id,
    jsonb_build_object(
      'conflictStatus', conflict_row.status,
      'paymentAllocationStatus', payment_row.allocation_status,
      'invoiceStatus', invoice_row.status,
      'invoiceBalance', invoice_row.balance_due::text
    ),
    jsonb_build_object(
      'conflictStatus', 'resolved',
      'paymentAllocationStatus', 'applied',
      'invoiceStatus', 'paid',
      'invoiceBalance', '0.00',
      'approvalRequestId', p_approval_request_id
    ),
    p_approval_request_id::text,
    'audit',
    now() + interval '7 years'
  );

  return result;
end;
$$;

revoke all on function public.resolve_storyops_payment_allocation(
  uuid, uuid, uuid, integer, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.resolve_storyops_payment_allocation(
  uuid, uuid, uuid, integer, integer, text
) to authenticated;

-- Migration 32's AFTER payment trigger acquired invoice locks after payment
-- locks. Signed Stripe payment reconciliation below owns allocation atomically
-- with the canonical invoice -> payment order.
drop trigger if exists payments_invoice_balance_reconciliation
  on public.payments;
revoke all on function public.refresh_storyops_invoice_balance_from_payment()
  from public, anon, authenticated, service_role;

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
      and payment.allocation_status = 'applied'
      and payment.processed_at is not null
      and payment.provider_payment_id ~ '^pi_[A-Za-z0-9_]+$'
      and payment.provider_amount_received = payment.amount
      and exists (
        select 1
        from public.webhook_events event
        where event.company_id = payment.company_id
          and event.provider = 'stripe'
          and event.status = 'processed'
          and event.payload ->> 'action' = 'payment_succeeded'
          and event.payload ->> 'quoteId' = p_quote_id::text
          and event.payload ->> 'amountCents' ~ '^[0-9]+$'
          and (event.payload ->> 'amountCents')::bigint
            = round(payment.amount * 100)::bigint
          and (
            event.payload ->> 'objectId' = payment.provider_checkout_id
            or event.payload ->> 'objectId' = payment.provider_payment_id
            or event.payload ->> 'paymentIntentId' = payment.provider_payment_id
          )
      )
  );
$$;

revoke all on function public.storyops_payment_has_provider_proof(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Hold checks wrap the existing deterministic checkout preparation. Locks are
-- taken before checking the hold so a concurrent provider event cannot race a
-- new collection attempt.
alter function public.prepare_storyops_invoice_checkout(
  uuid, uuid, uuid, uuid, integer
) rename to prepare_storyops_invoice_checkout_v1_0;

revoke all on function public.prepare_storyops_invoice_checkout_v1_0(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role;

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
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_role public.app_role;
  invoice_row public.invoices%rowtype;
  payment_attempt integer;
  claim jsonb;
begin
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
  if actor_role = 'customer' and not exists (
    select 1
    from public.customer_portal_users portal
    where portal.company_id = p_company_id
      and portal.user_id = p_actor_user_id
      and portal.customer_id = invoice_row.customer_id
  ) then
    raise exception using message = 'INVOICE_CHECKOUT_CUSTOMER_SCOPE_DENIED';
  end if;
  if exists (
    select 1
    from public.payment_allocation_conflicts conflict
    where conflict.company_id = p_company_id
      and conflict.invoice_id = p_invoice_id
      and conflict.status = 'open'
  ) or exists (
    select 1
    from public.payments payment
    where payment.company_id = p_company_id
      and payment.invoice_id = p_invoice_id
      and payment.provider = 'stripe'
      and payment.allocation_status = 'unapplied'
  ) then
    raise exception using message = 'PAYMENT_RECONCILIATION_REQUIRED';
  end if;
  claim := public.prepare_storyops_invoice_checkout_v1_0(
    p_company_id,
    p_actor_user_id,
    p_command_id,
    p_invoice_id,
    p_expected_version
  );
  if claim ->> 'claimStatus' = 'reserved' then
    select payment.checkout_attempt
    into payment_attempt
    from public.payments payment
    where payment.company_id = p_company_id
      and payment.id = (claim ->> 'paymentId')::uuid
    for update;
    if not found then
      raise exception using message = 'INVOICE_CHECKOUT_PAYMENT_CONFLICT';
    end if;
    claim := jsonb_set(
      jsonb_set(
        claim,
        '{providerIdempotencyKey}',
        to_jsonb(
          (claim ->> 'providerIdempotencyKey')
          || ':attempt:' || payment_attempt::text
        )
      ),
      '{checkoutAttempt}',
      to_jsonb(payment_attempt)
    );
    update public.idempotency_keys
    set response = claim
    where company_id = p_company_id
      and scope = 'invoice-checkout-v1'
      and key = p_command_id::text
      and request_hash = claim ->> 'requestHash'
      and status = 'in_progress';
    if not found then
      raise exception using message = 'INVOICE_CHECKOUT_RESERVATION_LOST';
    end if;
  end if;
  return claim;
end;
$$;

revoke all on function public.prepare_storyops_invoice_checkout(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_storyops_invoice_checkout(
  uuid, uuid, uuid, uuid, integer
) to service_role;

alter function public.prepare_storyops_deposit_checkout(
  uuid, uuid, uuid, uuid, integer
) rename to prepare_storyops_deposit_checkout_v1_0;

revoke all on function public.prepare_storyops_deposit_checkout_v1_0(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role;

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
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_role public.app_role;
  quote_customer_id uuid;
  invoice_id_value uuid;
  payment_attempt integer;
  claim jsonb;
begin
  actor_role := private.assert_storyops_edge_actor(
    p_company_id,
    p_actor_user_id,
    array['owner', 'dispatcher', 'customer']
  );
  select quote.customer_id
  into quote_customer_id
  from public.quotes quote
  where quote.company_id = p_company_id
    and quote.id = p_quote_id;
  if quote_customer_id is null then
    raise exception using message = 'GOLDEN_PATH_ACCEPTED_QUOTE_REQUIRED';
  end if;
  if actor_role = 'customer' and not exists (
    select 1
    from public.customer_portal_users portal
    where portal.company_id = p_company_id
      and portal.user_id = p_actor_user_id
      and portal.customer_id = quote_customer_id
  ) then
    raise exception using message = 'GOLDEN_PATH_CUSTOMER_SCOPE_REQUIRED';
  end if;

  select invoice.id
  into invoice_id_value
  from public.jobs job
  join public.invoices invoice
    on invoice.job_id = job.id
   and invoice.company_id = job.company_id
  where job.company_id = p_company_id
    and job.quote_id = p_quote_id
    and invoice.purpose = 'job'
  for update of invoice;

  if invoice_id_value is not null and exists (
    select 1
    from public.payment_allocation_conflicts conflict
    where conflict.company_id = p_company_id
      and conflict.invoice_id = invoice_id_value
      and conflict.status = 'open'
    union all
    select 1
    from public.payments payment
    where payment.company_id = p_company_id
      and payment.invoice_id = invoice_id_value
      and payment.provider = 'stripe'
      and payment.allocation_status = 'unapplied'
  ) then
    raise exception using message = 'PAYMENT_RECONCILIATION_REQUIRED';
  end if;

  claim := public.prepare_storyops_deposit_checkout_v1_0(
    p_company_id,
    p_actor_user_id,
    p_command_id,
    p_quote_id,
    p_expected_version
  );
  if claim ->> 'claimStatus' = 'reserved' then
    select payment.checkout_attempt
    into payment_attempt
    from public.payments payment
    where payment.company_id = p_company_id
      and payment.id = (claim ->> 'paymentId')::uuid
    for update;
    if not found then
      raise exception using message = 'GOLDEN_PATH_PAYMENT_CHECKOUT_CONFLICT';
    end if;
    claim := jsonb_set(
      jsonb_set(
        claim,
        '{providerIdempotencyKey}',
        to_jsonb(
          (claim ->> 'providerIdempotencyKey')
          || ':attempt:' || payment_attempt::text
        )
      ),
      '{checkoutAttempt}',
      to_jsonb(payment_attempt)
    );
    update public.idempotency_keys
    set response = claim
    where company_id = p_company_id
      and scope = 'deposit-checkout-v1'
      and key = p_command_id::text
      and request_hash = claim ->> 'requestHash'
      and status = 'in_progress';
    if not found then
      raise exception using message = 'GOLDEN_PATH_CHECKOUT_RESERVATION_LOST';
    end if;
  end if;
  return claim;
end;
$$;

revoke all on function public.prepare_storyops_deposit_checkout(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.prepare_storyops_deposit_checkout(
  uuid, uuid, uuid, uuid, integer
) to service_role;

-- Completion publishes only the Checkout Session identity. It never asserts a
-- payment, changes an invoice balance, or overwrites a bound PaymentIntent.
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
  payment_probe public.payments%rowtype;
  payment_row public.payments%rowtype;
  invoice_row public.invoices%rowtype;
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
  into payment_probe
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.id = p_payment_id;
  if not found then
    raise exception using message = 'INVOICE_CHECKOUT_PAYMENT_CONFLICT';
  end if;
  select *
  into invoice_row
  from public.invoices invoice
  where invoice.company_id = p_company_id
    and invoice.id = payment_probe.invoice_id
  for update;
  select *
  into payment_row
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.id = p_payment_id
  for update;
  if not found then
    raise exception using message = 'INVOICE_CHECKOUT_PAYMENT_CONFLICT';
  end if;

  if p_provider_checkout_id !~ '^cs_[A-Za-z0-9_]+$'
    or length(p_provider_checkout_id) > 255
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
    or payment_row.invoice_id <> invoice_row.id
    or payment_row.provider <> 'stripe'
    or payment_row.payment_type <> 'invoice'
    or payment_row.status not in ('pending', 'failed', 'succeeded')
    or reservation.response ->> 'checkoutAttempt'
      is distinct from payment_row.checkout_attempt::text
    or exists (
      select 1
      from public.payment_checkout_retirements retirement
      where retirement.company_id = p_company_id
        and retirement.provider_checkout_id = p_provider_checkout_id
    )
    or (
      payment_row.provider_checkout_id is not null
      and payment_row.provider_checkout_id <> p_provider_checkout_id
    )
  then
    raise exception using message = 'INVOICE_CHECKOUT_INVALID_PROVIDER_RECEIPT';
  end if;

  update public.payments
  set provider_checkout_id = p_provider_checkout_id,
      status = case when status = 'succeeded' then status else 'pending' end,
      processed_at = case when status = 'succeeded' then processed_at else null end,
      failure_code = case when status = 'succeeded' then failure_code else null end
  where id = payment_row.id
    and company_id = p_company_id;

  update public.idempotency_keys
  set status = 'completed',
      response = p_response,
      error_code = null,
      completed_at = now()
  where id = reservation.id
    and status = 'in_progress';
  if not found then
    raise exception using message = 'INVOICE_CHECKOUT_RESERVATION_LOST';
  end if;
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
set search_path = pg_catalog, public, auth
as $$
declare
  reservation public.idempotency_keys%rowtype;
  payment_probe public.payments%rowtype;
  payment_row public.payments%rowtype;
  invoice_row public.invoices%rowtype;
  quote_id_value uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'EDGE_SERVICE_ROLE_REQUIRED';
  end if;
  select *
  into reservation
  from public.idempotency_keys
  where company_id = p_company_id
    and scope = 'deposit-checkout-v1'
    and key = p_command_id::text
    and request_hash = p_request_hash
    and status = 'in_progress'
  for update;
  if not found then
    raise exception using message = 'GOLDEN_PATH_CHECKOUT_RESERVATION_LOST';
  end if;

  select *
  into payment_probe
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.id = p_payment_id;
  if not found then
    raise exception using message = 'GOLDEN_PATH_PAYMENT_CHECKOUT_CONFLICT';
  end if;
  select *
  into invoice_row
  from public.invoices invoice
  where invoice.company_id = p_company_id
    and invoice.id = payment_probe.invoice_id
  for update;
  select *
  into payment_row
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.id = p_payment_id
  for update;
  if not found then
    raise exception using message = 'GOLDEN_PATH_PAYMENT_CHECKOUT_CONFLICT';
  end if;
  select job.quote_id
  into quote_id_value
  from public.jobs job
  where job.company_id = p_company_id
    and job.id = invoice_row.job_id;

  if p_request_hash !~ '^[a-f0-9]{64}$'
    or p_provider_checkout_id !~ '^cs_[A-Za-z0-9_]+$'
    or length(p_provider_checkout_id) > 255
    or jsonb_typeof(p_response) <> 'object'
    or p_response ->> 'action' <> 'deposit.checkout'
    or p_response ->> 'paymentVerified' <> 'false'
    or p_response ->> 'depositReady' <> 'false'
    or p_response ->> 'status' <> 'checkout_open'
    or p_response ->> 'checkoutId' <> p_provider_checkout_id
    or p_response ->> 'quoteId' <> quote_id_value::text
    or p_response ->> 'invoiceId' <> invoice_row.id::text
    or p_response ->> 'amount' <> to_char(payment_row.amount, 'FM9999999990.00')
    or payment_row.invoice_id <> invoice_row.id
    or payment_row.provider <> 'stripe'
    or payment_row.payment_type <> 'deposit'
    or payment_row.status not in ('pending', 'failed', 'succeeded')
    or reservation.response ->> 'checkoutAttempt'
      is distinct from payment_row.checkout_attempt::text
    or exists (
      select 1
      from public.payment_checkout_retirements retirement
      where retirement.company_id = p_company_id
        and retirement.provider_checkout_id = p_provider_checkout_id
    )
    or (
      payment_row.provider_checkout_id is not null
      and payment_row.provider_checkout_id <> p_provider_checkout_id
    )
  then
    raise exception using message = 'GOLDEN_PATH_INVALID_CHECKOUT_RECEIPT';
  end if;

  update public.payments
  set provider_checkout_id = p_provider_checkout_id,
      status = case when status = 'succeeded' then status else 'pending' end,
      processed_at = case when status = 'succeeded' then processed_at else null end,
      failure_code = case when status = 'succeeded' then failure_code else null end
  where id = payment_row.id
    and company_id = p_company_id;

  update public.idempotency_keys
  set status = 'completed',
      response = p_response,
      error_code = null,
      completed_at = now()
  where id = reservation.id
    and status = 'in_progress';
  if not found then
    raise exception using message = 'GOLDEN_PATH_CHECKOUT_RESERVATION_LOST';
  end if;
end;
$$;

revoke all on function public.complete_storyops_invoice_checkout(
  uuid, uuid, text, uuid, text, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.complete_storyops_deposit_checkout(
  uuid, uuid, text, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.complete_storyops_invoice_checkout(
  uuid, uuid, text, uuid, text, jsonb
) to service_role;
grant execute on function public.complete_storyops_deposit_checkout(
  uuid, uuid, text, uuid, text, jsonb
) to service_role;

create or replace function private.reconcile_storyops_stripe_payment_v2(
  p_event_id uuid,
  p_payload_hash text,
  p_company_id uuid,
  p_reconciliation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  webhook_row public.webhook_events%rowtype;
  retirement_row public.payment_checkout_retirements%rowtype;
  payment_probe public.payments%rowtype;
  payment_row public.payments%rowtype;
  invoice_row public.invoices%rowtype;
  job_row public.jobs%rowtype;
  target_ids uuid[];
  object_id_value text;
  object_kind_value text;
  action_value text;
  event_type_value text;
  checkout_purpose_value text;
  checkout_attempt_value integer;
  payment_intent_id_value text;
  effective_payment_intent_id text;
  quote_id_value uuid;
  invoice_id_value uuid;
  invoice_version_value integer;
  amount_cents_value bigint;
  provider_amount numeric(12,2);
  occurred_at_value timestamptz;
  failure_code_value text;
  target_status text;
  conflict_code_value text;
  conflict_id_value uuid;
  retired_target_value boolean := false;
  terminal_checkout_value boolean := false;
  retirement_reason_value text;
  unexpected_key text;
  changed_value boolean := false;
  before_snapshot jsonb;
  after_snapshot jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'EDGE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_event_id is null
    or p_company_id is null
    or p_payload_hash !~ '^[a-f0-9]{64}$'
    or p_reconciliation is null
    or jsonb_typeof(p_reconciliation) <> 'object'
  then
    raise exception using message = 'INVALID_STRIPE_PAYMENT_RECONCILIATION';
  end if;

  select *
  into webhook_row
  from public.webhook_events event
  where event.id = p_event_id
  for update;
  if not found
    or webhook_row.company_id <> p_company_id
    or webhook_row.provider <> 'stripe'
    or webhook_row.payload_hash <> p_payload_hash
    or webhook_row.status <> 'processing'
  then
    raise exception using message = 'PROVIDER_RECONCILIATION_LEASE_LOST';
  end if;

  select key
  into unexpected_key
  from jsonb_object_keys(p_reconciliation) keys(key)
  where key <> all(array[
    'schemaVersion', 'provider', 'eventId', 'eventType', 'objectId',
    'objectKind', 'action', 'companyId', 'occurredAt', 'quoteId',
    'paymentIntentId', 'amountCents', 'currency', 'failureCode',
    'checkoutPurpose', 'checkoutAttempt', 'invoiceId', 'invoiceVersion'
  ]::text[])
  limit 1;
  if unexpected_key is not null then
    raise exception using message = 'UNSUPPORTED_STRIPE_PAYMENT_RECEIPT_FIELD';
  end if;
  if p_reconciliation ->> 'schemaVersion'
      is distinct from 'storyops-provider-receipt-v1'
    or p_reconciliation ->> 'provider' is distinct from 'stripe'
    or p_reconciliation ->> 'eventId'
      is distinct from webhook_row.provider_event_id
    or p_reconciliation ->> 'eventType'
      is distinct from webhook_row.event_type
    or p_reconciliation ->> 'companyId'
      is distinct from p_company_id::text
    or p_reconciliation ->> 'currency' is distinct from 'usd'
  then
    raise exception using message = 'STRIPE_PAYMENT_RECEIPT_SCOPE_MISMATCH';
  end if;

  object_id_value := nullif(p_reconciliation ->> 'objectId', '');
  object_kind_value := nullif(p_reconciliation ->> 'objectKind', '');
  action_value := nullif(p_reconciliation ->> 'action', '');
  event_type_value := nullif(p_reconciliation ->> 'eventType', '');
  checkout_purpose_value := nullif(p_reconciliation ->> 'checkoutPurpose', '');
  payment_intent_id_value := nullif(p_reconciliation ->> 'paymentIntentId', '');
  failure_code_value := left(
    regexp_replace(
      coalesce(nullif(p_reconciliation ->> 'failureCode', ''), ''),
      '[^a-zA-Z0-9_.:-]',
      '_',
      'g'
    ),
    120
  );
  begin
    quote_id_value := nullif(p_reconciliation ->> 'quoteId', '')::uuid;
    invoice_id_value := nullif(p_reconciliation ->> 'invoiceId', '')::uuid;
    invoice_version_value :=
      nullif(p_reconciliation ->> 'invoiceVersion', '')::integer;
    checkout_attempt_value :=
      nullif(p_reconciliation ->> 'checkoutAttempt', '')::integer;
    amount_cents_value := nullif(p_reconciliation ->> 'amountCents', '')::bigint;
    occurred_at_value := (p_reconciliation ->> 'occurredAt')::timestamptz;
  exception
    when invalid_text_representation
      or datetime_field_overflow
      or numeric_value_out_of_range
    then
      raise exception using message = 'STRIPE_PAYMENT_RECEIPT_TYPE_INVALID';
  end;

  if object_kind_value not in ('checkout', 'payment_intent')
    or action_value not in ('payment_pending', 'payment_succeeded', 'payment_failed')
    or checkout_purpose_value not in ('quote_deposit', 'invoice_balance')
    or checkout_attempt_value is null
    or checkout_attempt_value < 1
    or quote_id_value is null
    or amount_cents_value is null
    or amount_cents_value <= 0
    or amount_cents_value > 999999999999
    or occurred_at_value is null
    or occurred_at_value > now() + interval '5 minutes'
    or occurred_at_value < webhook_row.received_at - interval '3 years'
    or (
      checkout_purpose_value = 'invoice_balance'
      and (invoice_id_value is null or invoice_version_value < 1)
    )
    or (
      checkout_purpose_value = 'quote_deposit'
      and (invoice_id_value is not null or invoice_version_value is not null)
    )
  then
    raise exception using message = 'STRIPE_PAYMENT_RECEIPT_INVALID';
  end if;
  if (
      event_type_value like 'checkout.session.%'
      and (
        object_kind_value <> 'checkout'
        or object_id_value !~ '^cs_[A-Za-z0-9_]+$'
      )
    )
    or (
      event_type_value like 'payment_intent.%'
      and (
        object_kind_value <> 'payment_intent'
        or object_id_value !~ '^pi_[A-Za-z0-9_]+$'
      )
    )
    or (
      event_type_value not like 'checkout.session.%'
      and event_type_value not like 'payment_intent.%'
    )
    or (
      payment_intent_id_value is not null
      and payment_intent_id_value !~ '^pi_[A-Za-z0-9_]+$'
    )
  then
    raise exception using message = 'STRIPE_PAYMENT_PROVIDER_ID_INVALID';
  end if;
  if not (
    (
      event_type_value in (
        'checkout.session.completed',
        'checkout.session.async_payment_succeeded'
      )
      and action_value in ('payment_pending', 'payment_succeeded')
    )
    or (
      event_type_value in (
        'checkout.session.async_payment_failed',
        'checkout.session.expired',
        'payment_intent.payment_failed',
        'payment_intent.canceled'
      )
      and action_value = 'payment_failed'
    )
    or (
      event_type_value = 'payment_intent.processing'
      and action_value = 'payment_pending'
    )
    or (
      event_type_value = 'payment_intent.succeeded'
      and action_value = 'payment_succeeded'
    )
  ) then
    raise exception using message = 'STRIPE_PAYMENT_EVENT_ACTION_MISMATCH';
  end if;

  if object_kind_value = 'checkout' then
    select array_agg(payment.id order by payment.id)
    into target_ids
    from public.payments payment
    where payment.company_id = p_company_id
      and payment.provider = 'stripe'
      and payment.payment_type <> 'refund'
      and payment.provider_checkout_id = object_id_value;
    if coalesce(cardinality(target_ids), 0) = 0 then
      select *
      into retirement_row
      from public.payment_checkout_retirements retirement
      where retirement.company_id = p_company_id
        and retirement.provider_checkout_id = object_id_value;
      if found then
        target_ids := array[retirement_row.payment_id];
        retired_target_value := true;
      end if;
    end if;
  else
    select array_agg(payment.id order by payment.id)
    into target_ids
    from public.payments payment
    where payment.company_id = p_company_id
      and payment.provider = 'stripe'
      and payment.payment_type <> 'refund'
      and payment.provider_payment_id = object_id_value;

    if coalesce(cardinality(target_ids), 0) = 0 then
      select *
      into retirement_row
      from public.payment_checkout_retirements retirement
      where retirement.company_id = p_company_id
        and retirement.provider_payment_id = object_id_value;
      if found then
        target_ids := array[retirement_row.payment_id];
        retired_target_value := true;
      end if;
    end if;

    if coalesce(cardinality(target_ids), 0) = 0 then
      select retirement.*
      into retirement_row
      from public.payment_checkout_retirements retirement
      join public.payments payment
        on payment.id = retirement.payment_id
       and payment.company_id = retirement.company_id
      join public.invoices invoice
        on invoice.id = retirement.invoice_id
       and invoice.company_id = retirement.company_id
      join public.jobs job
        on job.id = invoice.job_id
       and job.company_id = invoice.company_id
      where retirement.company_id = p_company_id
        and retirement.checkout_attempt = checkout_attempt_value
        and job.quote_id = quote_id_value
        and (
          (
            checkout_purpose_value = 'quote_deposit'
            and payment.payment_type = 'deposit'
            and payment.idempotency_key = 'deposit:' || quote_id_value::text
          )
          or (
            checkout_purpose_value = 'invoice_balance'
            and payment.payment_type = 'invoice'
            and invoice.id = invoice_id_value
            and payment.idempotency_key =
              'storyops:invoice-balance:' || invoice_id_value::text
              || ':v' || invoice_version_value::text
              || ':' || round(payment.amount * 100)::bigint::text
          )
        );
      if found then
        target_ids := array[retirement_row.payment_id];
        retired_target_value := true;
      end if;
    end if;

    if coalesce(cardinality(target_ids), 0) = 0 then
      select array_agg(payment.id order by payment.id)
      into target_ids
      from public.payments payment
      join public.invoices invoice
        on invoice.id = payment.invoice_id
       and invoice.company_id = payment.company_id
      join public.jobs job
        on job.id = invoice.job_id
       and job.company_id = invoice.company_id
      where payment.company_id = p_company_id
        and payment.provider = 'stripe'
        and payment.provider_checkout_id is not null
        and payment.checkout_attempt = checkout_attempt_value
        and job.quote_id = quote_id_value
        and (
          (
            checkout_purpose_value = 'quote_deposit'
            and payment.payment_type = 'deposit'
            and payment.idempotency_key = 'deposit:' || quote_id_value::text
          )
          or (
            checkout_purpose_value = 'invoice_balance'
            and payment.payment_type = 'invoice'
            and invoice.id = invoice_id_value
            and payment.idempotency_key =
              'storyops:invoice-balance:' || invoice_id_value::text
              || ':v' || invoice_version_value::text
              || ':' || round(payment.amount * 100)::bigint::text
          )
        );
    end if;
  end if;
  if coalesce(cardinality(target_ids), 0) <> 1 then
    raise exception using message = 'STRIPE_PAYMENT_TARGET_NOT_EXACT';
  end if;

  select *
  into payment_probe
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.id = target_ids[1];
  if not found then
    raise exception using message = 'STRIPE_PAYMENT_TARGET_NOT_EXACT';
  end if;

  -- Canonical lock order for every checkout and signed payment path:
  -- webhook lease -> invoice -> payment.
  select *
  into invoice_row
  from public.invoices invoice
  where invoice.company_id = p_company_id
    and invoice.id = payment_probe.invoice_id
  for update;
  if not found then
    raise exception using message = 'STRIPE_PAYMENT_INVOICE_NOT_FOUND';
  end if;
  select *
  into payment_row
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.id = payment_probe.id
  for update;
  if not found then
    raise exception using message = 'STRIPE_PAYMENT_TARGET_NOT_EXACT';
  end if;
  select *
  into job_row
  from public.jobs job
  where job.company_id = p_company_id
    and job.id = invoice_row.job_id;

  if not found
    or payment_row.invoice_id <> invoice_row.id
    or payment_row.customer_id <> invoice_row.customer_id
    or payment_row.provider <> 'stripe'
    or payment_row.payment_type not in ('deposit', 'invoice')
    or job_row.quote_id <> quote_id_value
    or (
      not retired_target_value
      and payment_row.checkout_attempt <> checkout_attempt_value
    )
    or (
      retired_target_value
      and retirement_row.checkout_attempt <> checkout_attempt_value
    )
    or (
      checkout_purpose_value = 'quote_deposit'
      and (
        payment_row.payment_type <> 'deposit'
        or invoice_id_value is not null
      )
    )
    or (
      checkout_purpose_value = 'invoice_balance'
      and (
        payment_row.payment_type <> 'invoice'
        or invoice_row.id <> invoice_id_value
        or payment_row.idempotency_key <>
          'storyops:invoice-balance:' || invoice_id_value::text
          || ':v' || invoice_version_value::text
          || ':' || round(payment_row.amount * 100)::bigint::text
      )
    )
    or (
      object_kind_value = 'checkout'
      and (
        (
          not retired_target_value
          and payment_row.provider_checkout_id <> object_id_value
        )
        or (
          retired_target_value
          and (
            retirement_row.payment_id <> payment_row.id
            or retirement_row.invoice_id <> invoice_row.id
            or retirement_row.provider_checkout_id <> object_id_value
          )
        )
      )
    )
    or (
      object_kind_value = 'payment_intent'
      and (
        (
          not retired_target_value
          and payment_row.provider_checkout_id is null
        )
        or (
          retired_target_value
          and (
            retirement_row.payment_id <> payment_row.id
            or retirement_row.invoice_id <> invoice_row.id
            or (
              retirement_row.provider_payment_id is not null
              and retirement_row.provider_payment_id <> object_id_value
            )
          )
        )
      )
    )
  then
    raise exception using message = 'STRIPE_PAYMENT_TARGET_SCOPE_MISMATCH';
  end if;

  effective_payment_intent_id := case
    when object_kind_value = 'payment_intent' then object_id_value
    else payment_intent_id_value
  end;
  if action_value = 'payment_succeeded'
    and effective_payment_intent_id is null
  then
    raise exception using message = 'STRIPE_PAYMENT_INTENT_REQUIRED';
  end if;
  if not retired_target_value
    and payment_row.provider_payment_id is not null
    and effective_payment_intent_id is not null
    and payment_row.provider_payment_id <> effective_payment_intent_id
  then
    raise exception using message = 'STRIPE_PAYMENT_INTENT_CONFLICT';
  end if;

  target_status := case action_value
    when 'payment_succeeded' then
      case
        when payment_row.status in ('refunded', 'partially_refunded')
          then payment_row.status
        else 'succeeded'
      end
    when 'payment_failed' then
      case
        when payment_row.status in ('succeeded', 'refunded', 'partially_refunded')
          then payment_row.status
        else 'failed'
      end
    else
      case
        when payment_row.status in ('succeeded', 'failed', 'refunded', 'partially_refunded')
          then payment_row.status
        else 'pending'
      end
  end;
  provider_amount := (amount_cents_value::numeric / 100)::numeric(12,2);
  terminal_checkout_value :=
    not retired_target_value
    and object_kind_value = 'checkout'
    and event_type_value in (
      'checkout.session.expired',
      'checkout.session.async_payment_failed'
    )
    and action_value = 'payment_failed'
    and payment_row.status not in (
      'succeeded',
      'refunded',
      'partially_refunded'
    );
  retirement_reason_value := case event_type_value
    when 'checkout.session.expired' then 'checkout_session_expired'
    when 'checkout.session.async_payment_failed'
      then 'checkout_async_payment_failed'
    else null
  end;
  before_snapshot := jsonb_build_object(
    'status', payment_row.status,
    'providerCheckoutId', payment_row.provider_checkout_id,
    'providerPaymentId', payment_row.provider_payment_id,
    'allocationStatus', payment_row.allocation_status,
    'checkoutAttempt', payment_row.checkout_attempt,
    'retiredProviderTarget', retired_target_value,
    'invoiceStatus', invoice_row.status,
    'invoiceVersion', invoice_row.version,
    'invoiceBalance', invoice_row.balance_due::text
  );

  if retired_target_value then
    if action_value = 'payment_succeeded' then
      conflict_id_value := private.record_storyops_payment_allocation_conflict(
        p_company_id,
        payment_row.id,
        invoice_row.id,
        p_event_id,
        'retired_checkout_succeeded',
        payment_row.amount,
        provider_amount,
        invoice_row.balance_due,
        retirement_row.provider_checkout_id,
        effective_payment_intent_id,
        occurred_at_value
      );
      changed_value := true;
    end if;
  elsif terminal_checkout_value then
    insert into public.payment_checkout_retirements(
      company_id, payment_id, invoice_id, provider_event_id,
      provider_checkout_id, provider_payment_id, checkout_attempt,
      retirement_reason, provider_occurred_at
    )
    values (
      p_company_id,
      payment_row.id,
      invoice_row.id,
      p_event_id,
      payment_row.provider_checkout_id,
      coalesce(effective_payment_intent_id, payment_row.provider_payment_id),
      payment_row.checkout_attempt,
      retirement_reason_value,
      occurred_at_value
    )
    returning * into retirement_row;

    update public.payments
    set provider_checkout_id = null,
        provider_payment_id = null,
        provider_amount_received = null,
        allocation_status = null,
        checkout_attempt = checkout_attempt + 1,
        status = 'failed',
        processed_at = null,
        failure_code = retirement_reason_value
    where id = payment_row.id
      and company_id = p_company_id
      and checkout_attempt = payment_row.checkout_attempt
      and provider_checkout_id = retirement_row.provider_checkout_id;
    if not found then
      raise exception using message = 'STRIPE_CHECKOUT_RETIREMENT_CONFLICT';
    end if;

    update public.idempotency_keys
    set status = 'failed',
        response = jsonb_build_object(
          'status', 'checkout_retired',
          'paymentId', payment_row.id,
          'retiredCheckoutId', retirement_row.provider_checkout_id,
          'retiredAttempt', retirement_row.checkout_attempt,
          'nextAttempt', retirement_row.checkout_attempt + 1
        ),
        error_code = upper(retirement_reason_value),
        completed_at = now()
    where company_id = p_company_id
      and scope = case payment_row.payment_type
        when 'deposit' then 'deposit-checkout-v1'
        else 'invoice-checkout-v1'
      end
      and response ->> 'checkoutId' = retirement_row.provider_checkout_id
      and status in ('in_progress', 'completed');
    changed_value := true;
  else
    if action_value = 'payment_succeeded'
      and payment_row.status = 'succeeded'
      and payment_row.allocation_status in ('applied', 'unapplied')
      and (
        payment_row.provider_amount_received is null
        or payment_row.provider_amount_received <> provider_amount
      )
    then
      raise exception using message = 'STRIPE_PAYMENT_REPLAY_CONFLICT';
    end if;

    if target_status <> 'succeeded'
      or action_value <> 'payment_succeeded'
    then
      if payment_row.status is distinct from target_status
        or payment_row.provider_payment_id
          is distinct from coalesce(
            effective_payment_intent_id,
            payment_row.provider_payment_id
          )
        or payment_row.failure_code is distinct from (
          case when target_status = 'failed'
            then coalesce(nullif(failure_code_value, ''), 'provider_payment_failed')
            else null
          end
        )
      then
        update public.payments
        set provider_payment_id = coalesce(
              effective_payment_intent_id,
              provider_payment_id
            ),
            status = target_status,
            processed_at = case
              when target_status in ('refunded', 'partially_refunded')
                then coalesce(processed_at, occurred_at_value)
              else processed_at
            end,
            failure_code = case
              when target_status = 'failed'
                then coalesce(nullif(failure_code_value, ''), 'provider_payment_failed')
              else null
            end
        where id = payment_row.id
          and company_id = p_company_id;
        changed_value := true;
      end if;
    elsif payment_row.status = 'succeeded'
      and payment_row.allocation_status in ('applied', 'unapplied')
    then
      if payment_row.provider_payment_id is null then
        update public.payments
        set provider_payment_id = effective_payment_intent_id
        where id = payment_row.id
          and company_id = p_company_id;
        changed_value := true;
      end if;
      if payment_row.allocation_status = 'unapplied' then
        select conflict.id
        into conflict_id_value
        from public.payment_allocation_conflicts conflict
        where conflict.company_id = p_company_id
          and conflict.payment_id = payment_row.id
          and conflict.status = 'open'
        order by conflict.created_at, conflict.id
        limit 1;
        if conflict_id_value is null then
          raise exception using message = 'PAYMENT_RECONCILIATION_HOLD_MISSING';
        end if;
      end if;
    else
      conflict_code_value := null;
      if provider_amount > payment_row.amount then
        conflict_code_value := 'provider_overpayment';
      elsif provider_amount < payment_row.amount then
        conflict_code_value := 'provider_underpayment';
      elsif payment_row.payment_type = 'invoice'
        and invoice_row.version <> invoice_version_value
      then
        conflict_code_value := 'stale_invoice_version';
      elsif payment_row.payment_type = 'invoice'
        and (
          invoice_row.status not in ('open', 'past_due')
          or invoice_row.total <> invoice_row.amount_paid + invoice_row.balance_due
          or invoice_row.balance_due <= 0
        )
      then
        conflict_code_value := 'invoice_not_payable';
      elsif payment_row.payment_type = 'invoice'
        and provider_amount > invoice_row.balance_due
      then
        conflict_code_value := 'provider_overpayment';
      elsif payment_row.payment_type = 'invoice'
        and provider_amount < invoice_row.balance_due
      then
        conflict_code_value := 'provider_underpayment';
      elsif payment_row.payment_type = 'invoice'
        and payment_row.amount <> invoice_row.balance_due
      then
        conflict_code_value := 'local_payment_amount_mismatch';
      end if;

      update public.payments
      set provider_payment_id = effective_payment_intent_id,
          provider_amount_received = provider_amount,
          status = 'succeeded',
          processed_at = coalesce(processed_at, occurred_at_value),
          failure_code = null,
          allocation_status = case
            when conflict_code_value is null then 'applied'
            else 'unapplied'
          end
      where id = payment_row.id
        and company_id = p_company_id;
      changed_value := true;

      if conflict_code_value is null
        and payment_row.payment_type = 'invoice'
      then
        update public.invoices
        set amount_paid = amount_paid + provider_amount,
            balance_due = balance_due - provider_amount,
            status = 'paid',
            paid_at = coalesce(paid_at, occurred_at_value)
        where id = invoice_row.id
          and company_id = p_company_id
          and version = invoice_row.version
          and balance_due = provider_amount;
        if not found then
          raise exception using message = 'STRIPE_PAYMENT_INVOICE_VERSION_CONFLICT';
        end if;
      elsif conflict_code_value is not null then
        conflict_id_value := private.record_storyops_payment_allocation_conflict(
          p_company_id,
          payment_row.id,
          invoice_row.id,
          p_event_id,
          conflict_code_value,
          payment_row.amount,
          provider_amount,
          invoice_row.balance_due,
          payment_row.provider_checkout_id,
          effective_payment_intent_id,
          occurred_at_value
        );
      end if;
    end if;
  end if;

  select *
  into payment_row
  from public.payments payment
  where payment.company_id = p_company_id
    and payment.id = target_ids[1];
  select *
  into invoice_row
  from public.invoices invoice
  where invoice.company_id = p_company_id
    and invoice.id = payment_probe.invoice_id;
  after_snapshot := jsonb_build_object(
    'status', payment_row.status,
    'providerCheckoutId', payment_row.provider_checkout_id,
    'providerPaymentId', payment_row.provider_payment_id,
    'providerAmountReceived', payment_row.provider_amount_received,
    'allocationStatus', payment_row.allocation_status,
    'allocationConflictId', conflict_id_value,
    'checkoutAttempt', payment_row.checkout_attempt,
    'retiredCheckoutId', retirement_row.provider_checkout_id,
    'invoiceStatus', invoice_row.status,
    'invoiceVersion', invoice_row.version,
    'invoiceBalance', invoice_row.balance_due::text
  );

  if not exists (
    select 1
    from public.audit_events event
    where event.company_id = p_company_id
      and event.request_id = p_event_id::text
      and event.actor_type = 'provider'
      and event.actor_id = 'stripe'
      and event.action = 'provider_webhook_reconciled'
  ) then
    insert into public.audit_events(
      company_id, occurred_at, actor_type, actor_id, action,
      entity_type, entity_id, before_data, after_data, request_id,
      retention_class, retain_until
    )
    values (
      p_company_id,
      now(),
      'provider',
      'stripe',
      'provider_webhook_reconciled',
      case when conflict_id_value is null
        then 'payment' else 'payment_allocation_conflict' end,
      coalesce(conflict_id_value, payment_row.id),
      before_snapshot,
      after_snapshot,
      p_event_id::text,
      'audit',
      now() + interval '7 years'
    );
  end if;

  return jsonb_build_object(
    'disposition', 'processed',
    'changed', changed_value,
    'entityType', case when conflict_id_value is null
      then 'payment' else 'payment_allocation_conflict' end,
    'entityId', coalesce(conflict_id_value, payment_row.id),
    'providerEventId', webhook_row.provider_event_id,
    'allocationStatus', payment_row.allocation_status,
    'checkoutRetired', terminal_checkout_value,
    'checkoutAttempt', payment_row.checkout_attempt
  );
end;
$$;

revoke all on function private.reconcile_storyops_stripe_payment_v2(
  uuid, text, uuid, jsonb
) from public, anon, authenticated, service_role;

alter function public.reconcile_provider_webhook(
  uuid, text, uuid, text, jsonb
) rename to reconcile_provider_webhook_v1_0;

revoke all on function public.reconcile_provider_webhook_v1_0(
  uuid, text, uuid, text, jsonb
) from public, anon, authenticated, service_role;

create or replace function public.reconcile_provider_webhook(
  p_event_id uuid,
  p_payload_hash text,
  p_company_id uuid,
  p_provider text,
  p_reconciliation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'EDGE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_provider = 'stripe'
    and (
      p_reconciliation ->> 'objectKind' in ('checkout', 'payment_intent')
      or p_reconciliation ->> 'action' in (
        'payment_pending', 'payment_succeeded', 'payment_failed'
      )
      or p_reconciliation ->> 'eventType' like 'checkout.session.%'
      or p_reconciliation ->> 'eventType' like 'payment_intent.%'
    )
  then
    return private.reconcile_storyops_stripe_payment_v2(
      p_event_id,
      p_payload_hash,
      p_company_id,
      p_reconciliation
    );
  end if;
  return public.reconcile_provider_webhook_v1_0(
    p_event_id,
    p_payload_hash,
    p_company_id,
    p_provider,
    p_reconciliation
  );
end;
$$;

revoke all on function public.reconcile_provider_webhook(
  uuid, text, uuid, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_provider_webhook(
  uuid, text, uuid, text, jsonb
) to service_role;

-- Deposit readiness must never re-project a deposit amount over a separately
-- reconciled invoice-balance payment.
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
    and new.payload ->> 'checkoutPurpose' = 'quote_deposit'
    and new.payload ->> 'quoteId' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    quote_id_value := (new.payload ->> 'quoteId')::uuid;
    perform public.refresh_storyops_deposit_state(new.company_id, quote_id_value);
  end if;
  return new;
end;
$$;

revoke all on function public.refresh_storyops_deposit_from_webhook()
  from public, anon, authenticated, service_role;

-- Make an unapplied provider success visible to the back office without
-- granting browser roles direct access to payment-conflict records.
alter function public.get_storyops_workspace(uuid)
  rename to get_storyops_workspace_v1_1;

revoke all on function public.get_storyops_workspace_v1_1(uuid)
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
  result jsonb;
begin
  result := public.get_storyops_workspace_v1_1(p_company_id);
  if result #>> '{session,companyId}' is distinct from p_company_id::text
    or result #>> '{session,userId}' is distinct from auth.uid()::text
  then
    raise exception using message = 'Workspace identity did not match the authenticated scope';
  end if;

  if result #>> '{session,role}' in ('owner', 'dispatcher') then
    result := result || jsonb_build_object(
      'paymentAllocationConflicts',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', conflict.id,
          'paymentId', conflict.payment_id,
          'invoiceId', conflict.invoice_id,
          'invoiceNumber', invoice.invoice_number,
          'customerId', invoice.customer_id,
          'providerEventId', conflict.provider_event_id,
          'conflictCode', conflict.conflict_code,
          'intendedAmount', conflict.intended_amount::text,
          'verifiedAmount', conflict.verified_amount::text,
          'invoiceBalanceAtEvent', conflict.invoice_balance_at_event::text,
          'providerCheckoutId', conflict.provider_checkout_id,
          'providerPaymentId', conflict.provider_payment_id,
          'providerOccurredAt', conflict.provider_occurred_at,
          'approvalRequestId', conflict.approval_request_id,
          'resolutionAction', approval.action_type,
          'canApplyExactCurrentBalance',
            approval.action_type =
              'payment.allocation.apply_exact_current_balance',
          'status', conflict.status,
          'createdAt', conflict.created_at,
          'version', conflict.version,
          'nextAction', case
            when approval.action_type =
              'payment.allocation.apply_exact_current_balance'
            then 'Verify the exact Stripe charge and current invoice balance. After owner approval, apply only through the exact-balance resolver. Do not collect again while this hold is open.'
            else 'Do not apply these funds automatically. Verify Stripe and the accounting ledger, then complete a separately approved refund or manual accounting process. This hold remains open in V1 until exact provider-backed resolution is available.'
          end
        ) order by conflict.created_at, conflict.id)
        from public.payment_allocation_conflicts conflict
        join public.invoices invoice
          on invoice.id = conflict.invoice_id
         and invoice.company_id = conflict.company_id
        join public.approval_requests approval
          on approval.id = conflict.approval_request_id
         and approval.company_id = conflict.company_id
        where conflict.company_id = p_company_id
          and conflict.status = 'open'
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

-- Customers get a truthful collection hold, not internal reconciliation
-- details or a Pay button that can create a second external charge.
alter function public.get_customer_portal_state(uuid)
  rename to get_customer_portal_state_v2_0;

revoke all on function public.get_customer_portal_state_v2_0(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_customer_portal_state(
  p_company_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  base_state jsonb;
  customer_state jsonb;
  commercial_state jsonb;
  enriched_customers jsonb := '[]'::jsonb;
  enriched_invoices jsonb;
  customer_id_value uuid;
  customer_hold boolean;
  hold_message constant text :=
    'A verified payment needs office reconciliation. Online collection is paused so you are not charged twice.';
begin
  base_state := public.get_customer_portal_state_v2_0(p_company_id);
  if base_state ->> 'companyId' is distinct from p_company_id::text then
    raise exception using message = 'CUSTOMER_PORTAL_SCOPE_DENIED';
  end if;

  for customer_state in
    select value
    from jsonb_array_elements(coalesce(base_state -> 'customers', '[]'::jsonb))
  loop
    customer_id_value := (customer_state ->> 'customerId')::uuid;
    commercial_state := coalesce(customer_state -> 'commercial', '{}'::jsonb);

    select coalesce(
      jsonb_agg(
        projected_invoice.value || jsonb_build_object(
          'paymentReconciliationRequired',
          projected_invoice.payment_hold,
          'paymentReconciliationMessage',
          case when projected_invoice.payment_hold then hold_message else null end
        )
        order by projected_invoice.ordinal
      ),
      '[]'::jsonb
    )
    into enriched_invoices
    from (
      select
        invoice_item.value,
        invoice_item.ordinal,
        exists (
          select 1
          from public.payment_allocation_conflicts conflict
          join public.invoices invoice
            on invoice.id = conflict.invoice_id
           and invoice.company_id = conflict.company_id
          where conflict.company_id = p_company_id
            and conflict.invoice_id = (invoice_item.value ->> 'id')::uuid
            and invoice.customer_id = customer_id_value
            and conflict.status = 'open'
        ) or exists (
          select 1
          from public.payments payment
          join public.invoices invoice
            on invoice.id = payment.invoice_id
           and invoice.company_id = payment.company_id
          where payment.company_id = p_company_id
            and payment.invoice_id = (invoice_item.value ->> 'id')::uuid
            and invoice.customer_id = customer_id_value
            and payment.provider = 'stripe'
            and payment.allocation_status = 'unapplied'
        ) as payment_hold
      from jsonb_array_elements(
        coalesce(commercial_state -> 'invoices', '[]'::jsonb)
      ) with ordinality invoice_item(value, ordinal)
    ) projected_invoice;

    select exists (
      select 1
      from public.payment_allocation_conflicts conflict
      join public.invoices invoice
        on invoice.id = conflict.invoice_id
       and invoice.company_id = conflict.company_id
      where conflict.company_id = p_company_id
        and invoice.customer_id = customer_id_value
        and conflict.status = 'open'
    ) or exists (
      select 1
      from public.payments payment
      join public.invoices invoice
        on invoice.id = payment.invoice_id
       and invoice.company_id = payment.company_id
      where payment.company_id = p_company_id
        and invoice.customer_id = customer_id_value
        and payment.provider = 'stripe'
        and payment.allocation_status = 'unapplied'
    )
    into customer_hold;

    commercial_state :=
      jsonb_set(commercial_state, '{invoices}', enriched_invoices)
      || jsonb_build_object(
        'paymentReconciliationRequired', customer_hold,
        'paymentReconciliationMessage',
        case when customer_hold then hold_message else null end
      );
    enriched_customers := enriched_customers || jsonb_build_array(
      customer_state || jsonb_build_object('commercial', commercial_state)
    );
  end loop;

  return jsonb_set(base_state, '{customers}', enriched_customers);
end;
$$;

revoke all on function public.get_customer_portal_state(uuid)
  from public, anon, service_role;
grant execute on function public.get_customer_portal_state(uuid)
  to authenticated;

comment on column public.payments.provider_checkout_id is
  'Exact Stripe Checkout Session identity (cs_*); never a payment assertion.';
comment on column public.payments.provider_payment_id is
  'Exact provider payment identity (pi_* for Stripe); never a Checkout Session.';
comment on column public.payments.allocation_status is
  'Applied only when signed provider funds exactly match the permitted ledger transition; otherwise unapplied and held.';
comment on column public.payments.checkout_attempt is
  'Monotonic provider checkout generation. It advances only after a signed terminal Checkout event retires the prior cs_* identity.';
comment on table public.payment_allocation_conflicts is
  'Durable quarantine for verified provider funds that cannot be allocated exactly. Open rows block duplicate collection.';
comment on table public.payment_checkout_retirements is
  'Immutable evidence for signed terminal Stripe Checkout Sessions; retired identities can never be rebound to a payment attempt.';
comment on function public.resolve_storyops_payment_allocation(
  uuid, uuid, uuid, integer, integer, text
) is
  'Owner-only exact resolver. It consumes an approved immutable payload only when verified funds still equal both the local payment and current invoice balance.';

-- Keep the Edge service principal on typed RPCs only.
do $edge_acl_assertions$
declare
  relation_name text;
begin
  for relation_name in
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_type = 'BASE TABLE'
  loop
    if has_table_privilege(
      'service_role',
      format('public.%I', relation_name),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) then
      raise exception 'EDGE_SERVICE_ROLE_BASE_TABLE_PRIVILEGE:%', relation_name;
    end if;
  end loop;
end;
$edge_acl_assertions$;
