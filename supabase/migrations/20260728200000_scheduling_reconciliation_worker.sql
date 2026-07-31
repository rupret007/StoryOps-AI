-- Autonomous cleanup for expired, unconsumed live scheduling reservations.
--
-- The scheduling-evidence worker creates an exact deterministic Google
-- Calendar event before it records a promotable receipt. If the operator never
-- books that receipt, this durable queue ensures the confirmed event is
-- reconciled after the receipt expires without requiring a later request for
-- the same job.

create table public.scheduling_reconciliation_cases (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null
    default 'storyops-scheduling-reconciliation-case-v1'
    check (
      schema_version = 'storyops-scheduling-reconciliation-case-v1'
    ),
  company_id uuid not null references public.companies(id) on delete restrict,
  receipt_id uuid not null unique
    references public.scheduling_evidence_receipts(id) on delete restrict,
  job_id uuid not null references public.jobs(id) on delete restrict,
  status text not null default 'pending'
    check (
      status in (
        'pending',
        'leased',
        'retry_wait',
        'provider_unknown',
        'cancelled',
        'no_action',
        'manual_required'
      )
    ),
  attempt_count integer not null default 0
    check (attempt_count between 0 and 20),
  max_attempts integer not null default 8
    check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null,
  last_attempt_at timestamptz,
  last_error_code text
    check (
      last_error_code is null
      or (
        length(last_error_code) between 1 and 120
        and last_error_code ~ '^[A-Z0-9_]+$'
      )
    ),
  claimed_by uuid,
  claim_token uuid,
  claim_operation text
    check (
      claim_operation is null
      or claim_operation in ('cancel', 'reconcile')
    ),
  claim_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  check (
    (
      status = 'leased'
      and num_nonnulls(
        claimed_by,
        claim_token,
        claim_operation,
        claim_expires_at
      ) = 4
    )
    or (
      status <> 'leased'
      and num_nonnulls(
        claimed_by,
        claim_token,
        claim_operation,
        claim_expires_at
      ) = 0
    )
  ),
  check (
    (
      status in ('cancelled', 'no_action', 'manual_required')
      and completed_at is not null
    )
    or (
      status not in ('cancelled', 'no_action', 'manual_required')
      and completed_at is null
    )
  )
);

create index scheduling_reconciliation_cases_due_idx
  on public.scheduling_reconciliation_cases(
    next_attempt_at,
    created_at,
    company_id,
    id
  )
  where status in ('pending', 'retry_wait', 'provider_unknown', 'leased');

create table public.scheduling_reconciliation_attempts (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null
    default 'storyops-scheduling-reconciliation-attempt-v1'
    check (
      schema_version = 'storyops-scheduling-reconciliation-attempt-v1'
    ),
  company_id uuid not null references public.companies(id) on delete restrict,
  case_id uuid not null
    references public.scheduling_reconciliation_cases(id) on delete restrict,
  receipt_id uuid
    references public.scheduling_evidence_receipts(id) on delete restrict,
  attempt_number integer not null check (attempt_number between 1 and 20),
  operation text not null check (operation in ('cancel', 'reconcile')),
  status text not null default 'leased'
    check (
      status in (
        'leased',
        'cancelled',
        'retry_scheduled',
        'provider_unknown',
        'manual_required'
      )
    ),
  error_code text
    check (
      error_code is null
      or (
        length(error_code) between 1 and 120
        and error_code ~ '^[A-Z0-9_]+$'
      )
    ),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (case_id, attempt_number),
  check (
    (status = 'leased' and completed_at is null and error_code is null)
    or (status <> 'leased' and completed_at is not null)
  )
);

create index scheduling_reconciliation_attempts_case_idx
  on public.scheduling_reconciliation_attempts(
    company_id,
    case_id,
    attempt_number desc
  );

create or replace function private.storyops_calendar_event_id(
  p_provider_idempotency_key text
)
returns text
language sql
immutable
strict
set search_path = pg_catalog, extensions
as $$
  select 'storyops' || left(
    encode(
      extensions.digest(p_provider_idempotency_key, 'sha256'),
      'hex'
    ),
    40
  );
$$;

create table public.scheduling_calendar_booking_attempts (
  id uuid primary key default gen_random_uuid(),
  schema_version text not null
    default 'storyops-calendar-booking-attempt-v1'
    check (schema_version = 'storyops-calendar-booking-attempt-v1'),
  company_id uuid not null references public.companies(id) on delete restrict,
  job_id uuid not null references public.jobs(id) on delete restrict,
  job_version integer not null check (job_version > 0),
  property_id uuid not null references public.properties(id) on delete restrict,
  crew_id uuid not null references public.crews(id) on delete restrict,
  actor_user_id uuid references auth.users(id) on delete set null,
  scheduling_idempotency_key text not null
    check (length(btrim(scheduling_idempotency_key)) between 8 and 200),
  provider_idempotency_key text not null
    check (length(btrim(provider_idempotency_key)) between 8 and 220),
  calendar_id text not null
    check (length(btrim(calendar_id)) between 1 and 500),
  event_id text not null
    check (event_id ~ '^storyops[a-f0-9]{40}$'),
  event_etag text
    check (
      event_etag is null
      or length(btrim(event_etag)) between 1 and 500
    ),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'prepared'
    check (
      status in (
        'prepared',
        'provider_unknown',
        'confirmed',
        'receipt_linked',
        'consumed',
        'cancelled',
        'manual_required'
      )
    ),
  receipt_id uuid unique
    references public.scheduling_evidence_receipts(id) on delete restrict,
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  trace_id text
    check (trace_id is null or length(trace_id) between 1 and 200),
  prepared_at timestamptz not null default now(),
  provider_call_started_at timestamptz,
  provider_confirmed_at timestamptz,
  reconcile_after timestamptz not null,
  completed_at timestamptz,
  last_error_code text
    check (
      last_error_code is null
      or (
        length(last_error_code) between 1 and 120
        and last_error_code ~ '^[A-Z0-9_]+$'
      )
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, scheduling_idempotency_key),
  unique (company_id, provider_idempotency_key),
  unique (calendar_id, event_id),
  unique (company_id, id),
  check (ends_at > starts_at),
  check (
    provider_idempotency_key = scheduling_idempotency_key || ':calendar'
  ),
  check (
    (status in ('receipt_linked', 'consumed') and receipt_id is not null)
    or status in ('cancelled', 'manual_required')
    or (
      status not in (
        'receipt_linked', 'consumed', 'cancelled', 'manual_required'
      )
      and receipt_id is null
    )
  ),
  check (
    status not in ('confirmed', 'receipt_linked', 'consumed')
    or event_etag is not null
  ),
  check (
    (
      status in ('consumed', 'cancelled', 'manual_required')
      and completed_at is not null
    )
    or (
      status not in ('consumed', 'cancelled', 'manual_required')
      and completed_at is null
    )
  )
);

create index scheduling_calendar_booking_attempts_due_idx
  on public.scheduling_calendar_booking_attempts(
    reconcile_after,
    prepared_at,
    company_id,
    id
  )
  where status in ('prepared', 'provider_unknown', 'confirmed');

alter table public.scheduling_reconciliation_cases
  alter column receipt_id drop not null,
  add column calendar_attempt_id uuid not null unique
    references public.scheduling_calendar_booking_attempts(id)
    on delete restrict;

create or replace function public.storyops_calendar_booking_attempt_json(
  p_attempt public.scheduling_calendar_booking_attempts,
  p_replayed boolean default false
)
returns jsonb
language sql
stable
strict
set search_path = pg_catalog, public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', p_attempt.schema_version,
    'attemptId', p_attempt.id,
    'companyId', p_attempt.company_id,
    'jobId', p_attempt.job_id,
    'jobVersion', p_attempt.job_version,
    'propertyId', p_attempt.property_id,
    'crewId', p_attempt.crew_id,
    'schedulingIdempotencyKey', p_attempt.scheduling_idempotency_key,
    'providerIdempotencyKey', p_attempt.provider_idempotency_key,
    'calendarId', p_attempt.calendar_id,
    'eventId', p_attempt.event_id,
    'eventEtag', p_attempt.event_etag,
    'startsAt', p_attempt.starts_at,
    'endsAt', p_attempt.ends_at,
    'status', p_attempt.status,
    'receiptId', p_attempt.receipt_id,
    'reconcileAfter', p_attempt.reconcile_after,
    'requestHash', p_attempt.request_hash,
    'replayed', p_replayed
  ));
$$;

create or replace function public.prepare_storyops_calendar_booking_attempt(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_scheduling_idempotency_key text,
  p_request_hash text,
  p_attempt jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  existing_attempt public.scheduling_calendar_booking_attempts%rowtype;
  inserted_attempt public.scheduling_calendar_booking_attempts%rowtype;
  job_row public.jobs%rowtype;
  effective_hash text;
  provider_key text;
  event_id_value text;
  job_id_value uuid;
  property_id_value uuid;
  crew_id_value uuid;
  job_version_value integer;
  starts_at_value timestamptz;
  ends_at_value timestamptz;
  unexpected_key text;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_company_id is null
    or p_actor_user_id is null
    or p_attempt is null
    or jsonb_typeof(p_attempt) <> 'object'
    or octet_length(p_attempt::text) > 8192
    or length(btrim(coalesce(p_scheduling_idempotency_key, '')))
      not between 8 and 200
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_INVALID_REQUEST';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = p_actor_user_id
      and membership.active
      and membership.role in ('owner', 'dispatcher')
  ) then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_BACK_OFFICE_REQUIRED';
  end if;

  select key
  into unexpected_key
  from jsonb_object_keys(p_attempt) keys(key)
  where key not in (
    'schemaVersion', 'jobId', 'jobVersion', 'propertyId', 'crewId',
    'calendarId', 'eventId', 'providerIdempotencyKey',
    'startsAt', 'endsAt', 'traceId'
  )
  limit 1;
  if unexpected_key is not null
    or p_attempt ->> 'schemaVersion'
      <> 'storyops-calendar-booking-attempt-input-v1'
  then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_INVALID_ENVELOPE';
  end if;

  provider_key := p_attempt ->> 'providerIdempotencyKey';
  event_id_value := p_attempt ->> 'eventId';
  job_id_value := (p_attempt ->> 'jobId')::uuid;
  property_id_value := (p_attempt ->> 'propertyId')::uuid;
  crew_id_value := (p_attempt ->> 'crewId')::uuid;
  job_version_value := (p_attempt ->> 'jobVersion')::integer;
  starts_at_value := (p_attempt ->> 'startsAt')::timestamptz;
  ends_at_value := (p_attempt ->> 'endsAt')::timestamptz;

  effective_hash := public.storyops_json_sha256(jsonb_build_object(
    'actorUserId', p_actor_user_id,
    'companyId', p_company_id,
    'schedulingIdempotencyKey', p_scheduling_idempotency_key,
    'attempt', p_attempt
  ));
  if effective_hash <> p_request_hash then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_REQUEST_HASH_MISMATCH';
  end if;

  select *
  into existing_attempt
  from public.scheduling_calendar_booking_attempts booking_attempt
  where booking_attempt.company_id = p_company_id
    and booking_attempt.scheduling_idempotency_key
      = p_scheduling_idempotency_key
  for update;
  if found then
    if existing_attempt.request_hash <> effective_hash then
      raise exception 'CALENDAR_BOOKING_ATTEMPT_IDEMPOTENCY_CONFLICT';
    end if;
    return public.storyops_calendar_booking_attempt_json(
      existing_attempt,
      true
    );
  end if;

  if provider_key <> (p_scheduling_idempotency_key || ':calendar')
    or event_id_value <> private.storyops_calendar_event_id(provider_key)
    or length(btrim(coalesce(p_attempt ->> 'calendarId', '')))
      not between 1 and 500
    or job_version_value < 1
    or ends_at_value <= starts_at_value
    or starts_at_value <= clock_timestamp()
    or starts_at_value > clock_timestamp() + interval '366 days'
  then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_INVALID_IDENTITY';
  end if;

  select *
  into job_row
  from public.jobs job
  where job.id = job_id_value
    and job.company_id = p_company_id
  for update;
  if not found
    or job_row.version <> job_version_value
    or job_row.property_id <> property_id_value
    or job_row.status <> 'ready_to_schedule'
  then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_JOB_NOT_READY';
  end if;

  -- Every prepare for a job version serializes on the job row above. This
  -- post-lock check prevents concurrent requests with different idempotency
  -- keys from each publishing a distinct provider event before the receipt
  -- recorder can enforce its own one-active-receipt invariant.
  if exists (
    select 1
    from public.scheduling_calendar_booking_attempts booking_attempt
    where booking_attempt.company_id = p_company_id
      and booking_attempt.job_id = job_id_value
      and booking_attempt.job_version = job_version_value
      and booking_attempt.status in (
        'prepared', 'provider_unknown', 'confirmed', 'receipt_linked'
      )
  ) then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_ACTIVE_ATTEMPT_EXISTS';
  end if;

  perform 1
  from public.crews crew
  where crew.id = crew_id_value
    and crew.company_id = p_company_id
    and crew.active;
  if not found then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_CREW_REQUIRED';
  end if;

  insert into public.scheduling_calendar_booking_attempts(
    company_id,
    job_id,
    job_version,
    property_id,
    crew_id,
    actor_user_id,
    scheduling_idempotency_key,
    provider_idempotency_key,
    calendar_id,
    event_id,
    starts_at,
    ends_at,
    status,
    request_hash,
    trace_id,
    reconcile_after
  )
  values (
    p_company_id,
    job_id_value,
    job_version_value,
    property_id_value,
    crew_id_value,
    p_actor_user_id,
    p_scheduling_idempotency_key,
    provider_key,
    p_attempt ->> 'calendarId',
    event_id_value,
    starts_at_value,
    ends_at_value,
    'prepared',
    effective_hash,
    nullif(btrim(p_attempt ->> 'traceId'), ''),
    clock_timestamp() + interval '5 minutes'
  )
  returning * into inserted_attempt;

  insert into public.scheduling_reconciliation_cases(
    company_id,
    calendar_attempt_id,
    receipt_id,
    job_id,
    status,
    next_attempt_at
  )
  values (
    inserted_attempt.company_id,
    inserted_attempt.id,
    null,
    inserted_attempt.job_id,
    'pending',
    inserted_attempt.reconcile_after
  );

  return public.storyops_calendar_booking_attempt_json(
    inserted_attempt,
    false
  );
exception
  when invalid_text_representation
    or numeric_value_out_of_range
    or datetime_field_overflow
  then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_INVALID_TYPED_VALUE';
end;
$$;

create or replace function public.begin_storyops_calendar_booking_provider_call(
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt public.scheduling_calendar_booking_attempts%rowtype;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_TRUSTED_ROLE_REQUIRED';
  end if;
  select *
  into attempt
  from public.scheduling_calendar_booking_attempts booking_attempt
  where booking_attempt.id = p_attempt_id
  for update;
  if not found or attempt.status <> 'prepared' then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_RECONCILIATION_REQUIRED';
  end if;

  update public.scheduling_calendar_booking_attempts
  set
    status = 'provider_unknown',
    provider_call_started_at = clock_timestamp(),
    reconcile_after = clock_timestamp() + interval '2 minutes',
    last_error_code = 'PROVIDER_CALL_IN_PROGRESS',
    updated_at = now()
  where id = attempt.id
  returning * into attempt;

  update public.scheduling_reconciliation_cases
  set
    status = 'provider_unknown',
    next_attempt_at = attempt.reconcile_after,
    last_error_code = 'PROVIDER_CALL_IN_PROGRESS',
    updated_at = now()
  where calendar_attempt_id = attempt.id
    and status = 'pending';
  if not found then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_RECONCILIATION_FENCE_LOST';
  end if;

  return public.storyops_calendar_booking_attempt_json(attempt, false);
end;
$$;

create or replace function public.confirm_storyops_calendar_booking_attempt(
  p_attempt_id uuid,
  p_event_id text,
  p_event_etag text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempt public.scheduling_calendar_booking_attempts%rowtype;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_TRUSTED_ROLE_REQUIRED';
  end if;
  if length(btrim(coalesce(p_event_etag, ''))) not between 1 and 500 then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_INVALID_CONFIRMATION';
  end if;
  select *
  into attempt
  from public.scheduling_calendar_booking_attempts booking_attempt
  where booking_attempt.id = p_attempt_id
  for update;
  if not found
    or attempt.status <> 'provider_unknown'
    or attempt.event_id <> p_event_id
  then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_CONFIRMATION_CONFLICT';
  end if;

  update public.scheduling_calendar_booking_attempts
  set
    status = 'confirmed',
    event_etag = p_event_etag,
    provider_confirmed_at = clock_timestamp(),
    reconcile_after = clock_timestamp() + interval '5 minutes',
    last_error_code = null,
    updated_at = now()
  where id = attempt.id
  returning * into attempt;

  update public.scheduling_reconciliation_cases
  set
    status = 'pending',
    next_attempt_at = attempt.reconcile_after,
    last_error_code = null,
    updated_at = now()
  where calendar_attempt_id = attempt.id
    and status = 'provider_unknown';
  if not found then
    raise exception 'CALENDAR_BOOKING_ATTEMPT_RECONCILIATION_FENCE_LOST';
  end if;

  return public.storyops_calendar_booking_attempt_json(attempt, false);
end;
$$;

create or replace function public.queue_storyops_scheduling_reconciliation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  attempt public.scheduling_calendar_booking_attempts%rowtype;
  reconciliation_id uuid;
begin
  if new.evidence_mode = 'live'
    and new.capacity_provider = 'google_calendar'
    and new.capacity_disposition = 'eligible'
    and new.calendar_event_status = 'confirmed'
    and new.calendar_event_id is not null
    and new.calendar_event_etag is not null
  then
    select *
    into attempt
    from public.scheduling_calendar_booking_attempts booking_attempt
    where booking_attempt.company_id = new.company_id
      and booking_attempt.scheduling_idempotency_key = new.idempotency_key
    for update;
    if not found then
      insert into public.scheduling_calendar_booking_attempts(
        company_id,
        job_id,
        job_version,
        property_id,
        crew_id,
        actor_user_id,
        scheduling_idempotency_key,
        provider_idempotency_key,
        calendar_id,
        event_id,
        event_etag,
        starts_at,
        ends_at,
        status,
        receipt_id,
        request_hash,
        trace_id,
        provider_call_started_at,
        provider_confirmed_at,
        reconcile_after
      )
      values (
        new.company_id,
        new.job_id,
        new.job_version,
        new.property_id,
        new.crew_id,
        new.created_by,
        new.idempotency_key,
        new.idempotency_key || ':calendar',
        new.capacity_reference,
        new.calendar_event_id,
        new.calendar_event_etag,
        new.starts_at,
        new.ends_at,
        'receipt_linked',
        new.id,
        new.request_hash,
        new.trace_id,
        new.calendar_reconciled_at,
        new.calendar_reconciled_at,
        new.expires_at
      )
      returning * into attempt;
    else
      if attempt.job_id <> new.job_id
        or attempt.job_version <> new.job_version
        or attempt.property_id <> new.property_id
        or attempt.crew_id <> new.crew_id
        or attempt.calendar_id <> new.capacity_reference
        or attempt.event_id <> new.calendar_event_id
        or attempt.provider_idempotency_key
          <> new.idempotency_key || ':calendar'
        or attempt.starts_at <> new.starts_at
        or attempt.ends_at <> new.ends_at
        or attempt.status in (
          'receipt_linked', 'cancelled', 'manual_required'
        )
      then
        raise exception 'CALENDAR_BOOKING_ATTEMPT_RECEIPT_BINDING_CONFLICT';
      end if;
      update public.scheduling_calendar_booking_attempts
      set
        status = 'receipt_linked',
        event_etag = new.calendar_event_etag,
        provider_confirmed_at = coalesce(
          provider_confirmed_at,
          new.calendar_reconciled_at
        ),
        receipt_id = new.id,
        reconcile_after = new.expires_at,
        last_error_code = null,
        updated_at = now()
      where id = attempt.id
      returning * into attempt;
    end if;

    select id
    into reconciliation_id
    from public.scheduling_reconciliation_cases reconciliation
    where reconciliation.calendar_attempt_id = attempt.id
    for update;
    if found then
      update public.scheduling_reconciliation_cases
      set
        receipt_id = new.id,
        status = 'pending',
        next_attempt_at = new.expires_at,
        last_error_code = null,
        completed_at = null,
        updated_at = now()
      where id = reconciliation_id
        and status in ('pending', 'retry_wait', 'provider_unknown');
      if not found then
        raise exception 'CALENDAR_BOOKING_ATTEMPT_RECONCILIATION_FENCE_LOST';
      end if;
    else
      insert into public.scheduling_reconciliation_cases(
        company_id,
        calendar_attempt_id,
        receipt_id,
        job_id,
        status,
        next_attempt_at
      )
      values (
        new.company_id,
        attempt.id,
        new.id,
        new.job_id,
        'pending',
        new.expires_at
      );
    end if;
  end if;
  return new;
end;
$$;

create trigger scheduling_evidence_receipt_reconciliation_queue
after insert on public.scheduling_evidence_receipts
for each row execute function public.queue_storyops_scheduling_reconciliation();

-- The migration may be installed after a live receipt was recorded. Seed an
-- exact booking attempt and cleanup case for each historical reservation.
insert into public.scheduling_calendar_booking_attempts(
  company_id,
  job_id,
  job_version,
  property_id,
  crew_id,
  actor_user_id,
  scheduling_idempotency_key,
  provider_idempotency_key,
  calendar_id,
  event_id,
  event_etag,
  starts_at,
  ends_at,
  status,
  receipt_id,
  request_hash,
  trace_id,
  provider_call_started_at,
  provider_confirmed_at,
  reconcile_after,
  completed_at
)
select
  receipt.company_id,
  receipt.job_id,
  receipt.job_version,
  receipt.property_id,
  receipt.crew_id,
  receipt.created_by,
  receipt.idempotency_key,
  receipt.idempotency_key || ':calendar',
  receipt.capacity_reference,
  receipt.calendar_event_id,
  receipt.calendar_event_etag,
  receipt.starts_at,
  receipt.ends_at,
  case
    when consumption.id is not null then 'consumed'
    else 'receipt_linked'
  end,
  receipt.id,
  receipt.request_hash,
  receipt.trace_id,
  receipt.calendar_reconciled_at,
  receipt.calendar_reconciled_at,
  receipt.expires_at,
  case when consumption.id is not null then now() else null end
from public.scheduling_evidence_receipts receipt
left join public.scheduling_evidence_consumptions consumption
  on consumption.evidence_receipt_id = receipt.id
where receipt.evidence_mode = 'live'
  and receipt.capacity_provider = 'google_calendar'
  and receipt.capacity_disposition = 'eligible'
  and receipt.calendar_event_status = 'confirmed'
  and receipt.calendar_event_id is not null
  and receipt.calendar_event_etag is not null
on conflict (company_id, scheduling_idempotency_key) do nothing;

insert into public.scheduling_reconciliation_cases(
  company_id,
  calendar_attempt_id,
  receipt_id,
  job_id,
  status,
  next_attempt_at,
  completed_at
)
select
  attempt.company_id,
  attempt.id,
  receipt.id,
  receipt.job_id,
  case
    when consumption.id is not null then 'no_action'
    else 'pending'
  end,
  receipt.expires_at,
  case when consumption.id is not null then now() else null end
from public.scheduling_calendar_booking_attempts attempt
join public.scheduling_evidence_receipts receipt
  on receipt.company_id = attempt.company_id
  and receipt.idempotency_key = attempt.scheduling_idempotency_key
left join public.scheduling_evidence_consumptions consumption
  on consumption.evidence_receipt_id = receipt.id
where receipt.evidence_mode = 'live'
  and receipt.capacity_provider = 'google_calendar'
  and receipt.capacity_disposition = 'eligible'
  and receipt.calendar_event_status = 'confirmed'
  and receipt.calendar_event_id is not null
  and receipt.calendar_event_etag is not null
on conflict (calendar_attempt_id) do nothing;

create or replace function public.close_storyops_consumed_reconciliation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.scheduling_equipment_reservations
  set
    status = 'consumed',
    visit_id = new.visit_id,
    completed_at = now(),
    updated_at = now()
  where evidence_receipt_id = new.evidence_receipt_id
    and company_id = new.company_id
    and status = 'held';

  update public.scheduling_reconciliation_cases
  set
    status = 'no_action',
    completed_at = now(),
    last_error_code = null,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null,
    updated_at = now()
  where receipt_id = new.evidence_receipt_id
    and company_id = new.company_id
    and status in ('pending', 'retry_wait', 'provider_unknown');

  update public.scheduling_calendar_booking_attempts
  set
    status = 'consumed',
    completed_at = now(),
    last_error_code = null,
    updated_at = now()
  where receipt_id = new.evidence_receipt_id
    and company_id = new.company_id
    and status = 'receipt_linked';
  return new;
end;
$$;

create or replace function public.fence_storyops_scheduling_consumption()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reconciliation public.scheduling_reconciliation_cases%rowtype;
  receipt public.scheduling_evidence_receipts%rowtype;
begin
  select *
  into receipt
  from public.scheduling_evidence_receipts scheduling_receipt
  where scheduling_receipt.id = new.evidence_receipt_id
    and scheduling_receipt.company_id = new.company_id;
  if not found then
    raise exception 'SCHEDULING_RECONCILIATION_RECEIPT_REQUIRED';
  end if;

  -- This row lock is the transaction fence between booking consumption and a
  -- cleanup lease. The claim RPC locks the same row before it publishes a
  -- lease. Whichever transaction obtains the row first decides the outcome;
  -- the loser rechecks committed state and cannot mutate the provider.
  select *
  into reconciliation
  from public.scheduling_reconciliation_cases reconciliation_case
  where reconciliation_case.receipt_id = new.evidence_receipt_id
    and reconciliation_case.company_id = new.company_id
  for update;
  if not found then
    raise exception 'SCHEDULING_RECONCILIATION_FENCE_REQUIRED';
  end if;

  if reconciliation.status not in ('pending', 'retry_wait') then
    raise exception 'SCHEDULING_RECONCILIATION_BOOKING_FENCED';
  end if;
  if receipt.expires_at <= clock_timestamp() then
    raise exception 'SCHEDULING_RECONCILIATION_RECEIPT_EXPIRED';
  end if;
  return new;
end;
$$;

create trigger scheduling_evidence_consumption_reconciliation_fence
before insert on public.scheduling_evidence_consumptions
for each row execute function public.fence_storyops_scheduling_consumption();

create trigger scheduling_evidence_consumption_reconciliation_close
after insert on public.scheduling_evidence_consumptions
for each row execute function public.close_storyops_consumed_reconciliation();

create or replace function public.storyops_scheduling_reconciliation_result(
  p_case public.scheduling_reconciliation_cases
)
returns jsonb
language sql
stable
strict
set search_path = pg_catalog, public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 'storyops-scheduling-reconciliation-result-v1',
    'caseId', p_case.id,
    'receiptId', p_case.receipt_id,
    'companyId', p_case.company_id,
    'jobId', p_case.job_id,
    'status', p_case.status,
    'attemptCount', p_case.attempt_count,
    'nextAttemptAt', case
      when p_case.status in ('pending', 'retry_wait', 'provider_unknown')
        then p_case.next_attempt_at
      else null
    end,
    'errorCode', p_case.last_error_code,
    'calendarCancellationConfirmed', p_case.status = 'cancelled',
    'externalStateUnknown', p_case.status = 'provider_unknown',
    'manualReviewRequired', p_case.status = 'manual_required'
  ));
$$;

create or replace function public.claim_storyops_scheduling_reconciliation(
  p_company_id uuid,
  p_worker_id uuid,
  p_lease_seconds integer default 90
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  expired_case public.scheduling_reconciliation_cases%rowtype;
  consumed_case public.scheduling_reconciliation_cases%rowtype;
  invalid_case public.scheduling_reconciliation_cases%rowtype;
  candidate public.scheduling_reconciliation_cases%rowtype;
  booking_attempt public.scheduling_calendar_booking_attempts%rowtype;
  token_value uuid;
  operation_value text;
  next_attempt_number integer;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'SCHEDULING_RECONCILIATION_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_company_id is null
    or not exists (
      select 1
      from public.companies company
      where company.id = p_company_id
    )
    or p_worker_id is null
    or p_lease_seconds is null
    or p_lease_seconds not between 30 and 300
  then
    raise exception 'SCHEDULING_RECONCILIATION_INVALID_CLAIM';
  end if;

  -- A worker can disappear after a provider mutation but before durable
  -- completion. An expired lease is therefore provider-unknown, not a retry or
  -- a success. The next operation is a read-back reconciliation.
  for expired_case in
    select reconciliation.*
    from public.scheduling_reconciliation_cases reconciliation
    where reconciliation.company_id = p_company_id
      and reconciliation.status = 'leased'
      and reconciliation.claim_expires_at <= now()
    order by reconciliation.claim_expires_at, reconciliation.id
    for update of reconciliation skip locked
    limit 100
  loop
    update public.scheduling_reconciliation_attempts
    set
      status = case
        when expired_case.attempt_count >= expired_case.max_attempts
          then 'manual_required'
        else 'provider_unknown'
      end,
      error_code = 'WORKER_LEASE_EXPIRED',
      completed_at = now()
    where case_id = expired_case.id
      and attempt_number = expired_case.attempt_count
      and status = 'leased';

    update public.scheduling_reconciliation_cases
    set
      status = case
        when expired_case.attempt_count >= expired_case.max_attempts
          then 'manual_required'
        else 'provider_unknown'
      end,
      next_attempt_at = now(),
      last_error_code = 'WORKER_LEASE_EXPIRED',
      claimed_by = null,
      claim_token = null,
      claim_operation = null,
      claim_expires_at = null,
      completed_at = case
        when expired_case.attempt_count >= expired_case.max_attempts
          then now()
        else null
      end,
      updated_at = now()
    where id = expired_case.id;

    update public.scheduling_calendar_booking_attempts
    set
      status = case
        when expired_case.attempt_count >= expired_case.max_attempts
          then 'manual_required'
        else 'provider_unknown'
      end,
      completed_at = case
        when expired_case.attempt_count >= expired_case.max_attempts
          then now()
        else null
      end,
      last_error_code = 'WORKER_LEASE_EXPIRED',
      reconcile_after = now(),
      updated_at = now()
    where id = expired_case.calendar_attempt_id
      and receipt_id is null
      and status in ('prepared', 'provider_unknown', 'confirmed');
  end loop;

  -- A receipt consumed through the booking transaction must never have its
  -- calendar event removed. This repair covers a disabled trigger or a receipt
  -- consumed before this migration was installed.
  for consumed_case in
    select reconciliation.*
    from public.scheduling_reconciliation_cases reconciliation
    where reconciliation.company_id = p_company_id
      and reconciliation.status in (
      'pending', 'retry_wait', 'provider_unknown'
    )
      and exists (
        select 1
        from public.scheduling_evidence_consumptions consumption
        where consumption.evidence_receipt_id = reconciliation.receipt_id
      )
    order by reconciliation.next_attempt_at, reconciliation.id
    for update of reconciliation skip locked
    limit 100
  loop
    update public.scheduling_reconciliation_cases
    set
      status = 'no_action',
      completed_at = now(),
      last_error_code = null,
      updated_at = now()
    where id = consumed_case.id;
  end loop;

  -- Provider IDs are deterministic from the exact scheduling idempotency key.
  -- A mismatched identity is quarantined without making a provider call.
  for invalid_case in
    select reconciliation.*
    from public.scheduling_reconciliation_cases reconciliation
    join public.scheduling_calendar_booking_attempts attempt
      on attempt.id = reconciliation.calendar_attempt_id
      and attempt.company_id = reconciliation.company_id
    left join public.scheduling_evidence_receipts due_receipt
      on due_receipt.id = reconciliation.receipt_id
      and due_receipt.company_id = reconciliation.company_id
    where reconciliation.company_id = p_company_id
      and reconciliation.status in (
      'pending', 'retry_wait', 'provider_unknown'
    )
      and reconciliation.next_attempt_at <= now()
      and (
        attempt.event_id
          <> private.storyops_calendar_event_id(
            attempt.provider_idempotency_key
          )
        or attempt.provider_idempotency_key
          <> attempt.scheduling_idempotency_key || ':calendar'
        or attempt.status in ('cancelled', 'manual_required')
        or (
          reconciliation.receipt_id is not null
          and (
            due_receipt.id is null
            or due_receipt.evidence_mode <> 'live'
            or due_receipt.capacity_provider <> 'google_calendar'
            or due_receipt.capacity_disposition <> 'eligible'
            or due_receipt.calendar_event_status <> 'confirmed'
            or due_receipt.calendar_event_id <> attempt.event_id
            or due_receipt.calendar_event_etag is null
            or due_receipt.idempotency_key
              <> attempt.scheduling_idempotency_key
          )
        )
      )
    order by reconciliation.next_attempt_at, reconciliation.id
    for update of reconciliation skip locked
    limit 100
  loop
    update public.scheduling_reconciliation_cases
    set
      status = 'manual_required',
      completed_at = now(),
      last_error_code = 'CALENDAR_IDENTITY_MISMATCH',
      updated_at = now()
    where id = invalid_case.id;

    update public.scheduling_calendar_booking_attempts
    set
      status = 'manual_required',
      completed_at = now(),
      last_error_code = 'CALENDAR_IDENTITY_MISMATCH',
      updated_at = now()
    where id = invalid_case.calendar_attempt_id
      and status not in ('cancelled', 'manual_required');
  end loop;

  select reconciliation.*
  into candidate
  from public.scheduling_reconciliation_cases reconciliation
  join public.scheduling_calendar_booking_attempts attempt
    on attempt.id = reconciliation.calendar_attempt_id
    and attempt.company_id = reconciliation.company_id
  left join public.scheduling_evidence_receipts due_receipt
    on due_receipt.id = reconciliation.receipt_id
    and due_receipt.company_id = reconciliation.company_id
  where reconciliation.company_id = p_company_id
    and reconciliation.status in ('pending', 'retry_wait', 'provider_unknown')
    and reconciliation.next_attempt_at <= now()
    and attempt.status in (
      'prepared', 'provider_unknown', 'confirmed', 'receipt_linked'
    )
    and attempt.event_id
      = private.storyops_calendar_event_id(
        attempt.provider_idempotency_key
      )
    and (
      (
        reconciliation.receipt_id is null
        and attempt.receipt_id is null
        and attempt.reconcile_after <= now()
      )
      or (
        reconciliation.receipt_id is not null
        and attempt.receipt_id = reconciliation.receipt_id
        and attempt.status = 'receipt_linked'
        and due_receipt.expires_at <= now()
        and due_receipt.evidence_mode = 'live'
        and due_receipt.capacity_provider = 'google_calendar'
        and due_receipt.capacity_disposition = 'eligible'
        and due_receipt.calendar_event_status = 'confirmed'
        and due_receipt.calendar_event_id = attempt.event_id
        and due_receipt.calendar_event_etag = attempt.event_etag
      )
    )
    and not exists (
      select 1
      from public.scheduling_evidence_consumptions consumption
      where consumption.evidence_receipt_id = reconciliation.receipt_id
    )
  order by reconciliation.next_attempt_at, reconciliation.created_at,
    reconciliation.id
  for update of reconciliation skip locked
  limit 1;

  if not found then
    return null;
  end if;

  -- The case row was locked by the candidate SELECT. A booking transaction
  -- that obtained the same fence first closes it as no_action; this defensive
  -- recheck prevents a stale predicate from ever publishing a cleanup lease.
  if exists (
    select 1
    from public.scheduling_evidence_consumptions consumption
    where consumption.evidence_receipt_id = candidate.receipt_id
  ) then
    update public.scheduling_equipment_reservations reservation
    set
      status = 'consumed',
      visit_id = consumption.visit_id,
      completed_at = now(),
      updated_at = now()
    from public.scheduling_evidence_consumptions consumption
    where consumption.evidence_receipt_id = candidate.receipt_id
      and reservation.evidence_receipt_id = candidate.receipt_id
      and reservation.company_id = candidate.company_id
      and reservation.status = 'held';

    update public.scheduling_reconciliation_cases
    set
      status = 'no_action',
      completed_at = now(),
      last_error_code = null,
      updated_at = now()
    where id = candidate.id
    returning * into candidate;
    return null;
  end if;

  if candidate.attempt_count >= candidate.max_attempts then
    update public.scheduling_reconciliation_cases
    set
      status = 'manual_required',
      completed_at = now(),
      last_error_code = 'RECONCILIATION_ATTEMPTS_EXHAUSTED',
      updated_at = now()
    where id = candidate.id
    returning * into candidate;

    update public.scheduling_calendar_booking_attempts
    set
      status = 'manual_required',
      completed_at = now(),
      last_error_code = 'RECONCILIATION_ATTEMPTS_EXHAUSTED',
      updated_at = now()
    where id = candidate.calendar_attempt_id
      and status not in ('cancelled', 'manual_required');

    insert into public.audit_events(
      company_id,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      after_data
    )
    values (
      candidate.company_id,
      'system',
      'scheduling-reconciliation-v1',
      'scheduling_reconciliation.manual_required',
      'scheduling_reconciliation_case',
      candidate.id,
      jsonb_build_object(
        'receiptId', candidate.receipt_id,
        'jobId', candidate.job_id,
        'errorCode', candidate.last_error_code,
        'attemptCount', candidate.attempt_count
      )
    );
    return null;
  end if;

  select *
  into booking_attempt
  from public.scheduling_calendar_booking_attempts attempt
  where attempt.id = candidate.calendar_attempt_id
    and attempt.company_id = candidate.company_id
  for update;
  if not found then
    raise exception 'SCHEDULING_RECONCILIATION_CALENDAR_ATTEMPT_LOST';
  end if;

  operation_value := case
    when candidate.status = 'provider_unknown'
      or candidate.receipt_id is null
      then 'reconcile'
    else 'cancel'
  end;
  token_value := gen_random_uuid();
  next_attempt_number := candidate.attempt_count + 1;

  update public.scheduling_reconciliation_cases
  set
    status = 'leased',
    attempt_count = next_attempt_number,
    last_attempt_at = now(),
    claimed_by = p_worker_id,
    claim_token = token_value,
    claim_operation = operation_value,
    claim_expires_at = now() + make_interval(secs => p_lease_seconds),
    completed_at = null,
    updated_at = now()
  where id = candidate.id
  returning * into candidate;

  insert into public.scheduling_reconciliation_attempts(
    company_id,
    case_id,
    receipt_id,
    attempt_number,
    operation,
    status
  )
  values (
    candidate.company_id,
    candidate.id,
    candidate.receipt_id,
    next_attempt_number,
    operation_value,
    'leased'
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 'storyops-scheduling-reconciliation-claim-v1',
    'caseId', candidate.id,
    'receiptId', candidate.receipt_id,
    'companyId', candidate.company_id,
    'jobId', candidate.job_id,
    'claimToken', token_value,
    'operation', operation_value,
    'attempt', next_attempt_number,
    'calendarId', booking_attempt.calendar_id,
    'eventId', booking_attempt.event_id,
    'eventEtag', booking_attempt.event_etag,
    'idempotencyKey', booking_attempt.provider_idempotency_key,
    'window', jsonb_build_object(
      'start', booking_attempt.starts_at,
      'end', booking_attempt.ends_at
    ),
    'receiptExpiresAt', case
      when candidate.receipt_id is null then null
      else (
        select due_receipt.expires_at
        from public.scheduling_evidence_receipts due_receipt
        where due_receipt.id = candidate.receipt_id
      )
    end,
    'leaseExpiresAt', candidate.claim_expires_at
  ));
end;
$$;

create or replace function public.complete_storyops_scheduling_reconciliation(
  p_case_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reconciliation public.scheduling_reconciliation_cases%rowtype;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'SCHEDULING_RECONCILIATION_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_case_id is null or p_claim_token is null then
    raise exception 'SCHEDULING_RECONCILIATION_INVALID_COMPLETION';
  end if;

  select *
  into reconciliation
  from public.scheduling_reconciliation_cases reconciliation_case
  where reconciliation_case.id = p_case_id
  for update;
  if not found
    or reconciliation.status <> 'leased'
    or reconciliation.claim_token <> p_claim_token
    or reconciliation.claim_expires_at <= now()
  then
    raise exception 'SCHEDULING_RECONCILIATION_CLAIM_LOST';
  end if;

  -- This should be unreachable because the BEFORE INSERT consumption fence
  -- rejects a leased case. If the invariant is bypassed or corrupted, never
  -- claim calendar cancellation for a consumed booking.
  if exists (
    select 1
    from public.scheduling_evidence_consumptions consumption
    where consumption.evidence_receipt_id = reconciliation.receipt_id
  ) then
    update public.scheduling_equipment_reservations reservation
    set
      status = 'consumed',
      visit_id = consumption.visit_id,
      completed_at = now(),
      updated_at = now()
    from public.scheduling_evidence_consumptions consumption
    where consumption.evidence_receipt_id = reconciliation.receipt_id
      and reservation.evidence_receipt_id = reconciliation.receipt_id
      and reservation.company_id = reconciliation.company_id
      and reservation.status = 'held';

    update public.scheduling_reconciliation_attempts
    set
      status = 'manual_required',
      error_code = 'CONSUMPTION_RACE_DETECTED',
      completed_at = now()
    where case_id = reconciliation.id
      and attempt_number = reconciliation.attempt_count
      and status = 'leased';

    update public.scheduling_reconciliation_cases
    set
      status = 'manual_required',
      last_error_code = 'CONSUMPTION_RACE_DETECTED',
      claimed_by = null,
      claim_token = null,
      claim_operation = null,
      claim_expires_at = null,
      completed_at = now(),
      updated_at = now()
    where id = reconciliation.id
    returning * into reconciliation;

    update public.scheduling_calendar_booking_attempts
    set
      status = 'manual_required',
      completed_at = now(),
      last_error_code = 'CONSUMPTION_RACE_DETECTED',
      updated_at = now()
    where id = reconciliation.calendar_attempt_id
      and status not in ('cancelled', 'manual_required');

    insert into public.audit_events(
      company_id,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      after_data
    )
    values (
      reconciliation.company_id,
      'system',
      'scheduling-reconciliation-v1',
      'scheduling_reconciliation.consumption_race_detected',
      'scheduling_reconciliation_case',
      reconciliation.id,
      jsonb_build_object(
        'receiptId', reconciliation.receipt_id,
        'jobId', reconciliation.job_id,
        'attemptCount', reconciliation.attempt_count,
        'calendarCancellationConfirmed', false,
        'manualReviewRequired', true
      )
    );
    return public.storyops_scheduling_reconciliation_result(reconciliation);
  end if;

  update public.scheduling_reconciliation_attempts
  set
    status = 'cancelled',
    error_code = null,
    completed_at = now()
  where case_id = reconciliation.id
    and attempt_number = reconciliation.attempt_count
    and status = 'leased';
  if not found then
    raise exception 'SCHEDULING_RECONCILIATION_ATTEMPT_LOST';
  end if;

  update public.scheduling_reconciliation_cases
  set
    status = 'cancelled',
    last_error_code = null,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null,
    completed_at = now(),
    updated_at = now()
  where id = reconciliation.id
  returning * into reconciliation;

  update public.scheduling_calendar_booking_attempts
  set
    status = 'cancelled',
    completed_at = now(),
    last_error_code = null,
    updated_at = now()
  where id = reconciliation.calendar_attempt_id
    and status not in ('cancelled', 'manual_required');
  if not found then
    raise exception 'SCHEDULING_RECONCILIATION_CALENDAR_ATTEMPT_LOST';
  end if;

  update public.scheduling_equipment_reservations
  set
    status = 'released',
    completed_at = now(),
    updated_at = now()
  where evidence_receipt_id = reconciliation.receipt_id
    and company_id = reconciliation.company_id
    and status = 'held';

  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data
  )
  values (
    reconciliation.company_id,
    'system',
    'scheduling-reconciliation-v1',
    'scheduling_reconciliation.calendar_cancelled',
    'scheduling_reconciliation_case',
    reconciliation.id,
    jsonb_build_object(
      'receiptId', reconciliation.receipt_id,
      'jobId', reconciliation.job_id,
      'attemptCount', reconciliation.attempt_count,
      'calendarCancellationConfirmed', true
    )
  );

  return public.storyops_scheduling_reconciliation_result(reconciliation);
end;
$$;

create or replace function public.fail_storyops_scheduling_reconciliation(
  p_case_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_disposition text,
  p_retry_after_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  reconciliation public.scheduling_reconciliation_cases%rowtype;
  next_status text;
  attempt_status text;
  retry_seconds integer;
begin
  if auth.role() is distinct from 'service_role'
    and not (
      session_user = 'postgres'
      and current_setting('role', true) = 'none'
    )
  then
    raise exception 'SCHEDULING_RECONCILIATION_TRUSTED_ROLE_REQUIRED';
  end if;
  if p_case_id is null
    or p_claim_token is null
    or coalesce(p_error_code, '') !~ '^[A-Z0-9_]{1,120}$'
    or p_disposition not in ('retry', 'unknown', 'manual_required')
    or p_retry_after_seconds is null
    or p_retry_after_seconds not between 30 and 3600
  then
    raise exception 'SCHEDULING_RECONCILIATION_INVALID_FAILURE';
  end if;

  select *
  into reconciliation
  from public.scheduling_reconciliation_cases reconciliation_case
  where reconciliation_case.id = p_case_id
  for update;
  if not found
    or reconciliation.status <> 'leased'
    or reconciliation.claim_token <> p_claim_token
    or reconciliation.claim_expires_at <= now()
  then
    raise exception 'SCHEDULING_RECONCILIATION_CLAIM_LOST';
  end if;

  retry_seconds := least(
    3600,
    greatest(
      p_retry_after_seconds,
      (30 * power(2, least(reconciliation.attempt_count, 6)))::integer
    )
  );
  next_status := case
    when p_disposition = 'manual_required'
      or reconciliation.attempt_count >= reconciliation.max_attempts
      then 'manual_required'
    when p_disposition = 'unknown' then 'provider_unknown'
    else 'retry_wait'
  end;
  attempt_status := case next_status
    when 'retry_wait' then 'retry_scheduled'
    when 'provider_unknown' then 'provider_unknown'
    else 'manual_required'
  end;

  update public.scheduling_reconciliation_attempts
  set
    status = attempt_status,
    error_code = p_error_code,
    completed_at = now()
  where case_id = reconciliation.id
    and attempt_number = reconciliation.attempt_count
    and status = 'leased';
  if not found then
    raise exception 'SCHEDULING_RECONCILIATION_ATTEMPT_LOST';
  end if;

  update public.scheduling_reconciliation_cases
  set
    status = next_status,
    next_attempt_at = case
      when next_status in ('retry_wait', 'provider_unknown')
        then now() + make_interval(secs => retry_seconds)
      else next_attempt_at
    end,
    last_error_code = p_error_code,
    claimed_by = null,
    claim_token = null,
    claim_operation = null,
    claim_expires_at = null,
    completed_at = case
      when next_status = 'manual_required' then now()
      else null
    end,
    updated_at = now()
  where id = reconciliation.id
  returning * into reconciliation;

  if next_status = 'manual_required' then
    update public.scheduling_calendar_booking_attempts
    set
      status = 'manual_required',
      completed_at = now(),
      last_error_code = p_error_code,
      updated_at = now()
    where id = reconciliation.calendar_attempt_id
      and status not in ('cancelled', 'manual_required');
  elsif next_status = 'provider_unknown' then
    update public.scheduling_calendar_booking_attempts
    set
      status = 'provider_unknown',
      reconcile_after = reconciliation.next_attempt_at,
      last_error_code = p_error_code,
      updated_at = now()
    where id = reconciliation.calendar_attempt_id
      and receipt_id is null
      and status in ('prepared', 'provider_unknown', 'confirmed');
  end if;

  insert into public.audit_events(
    company_id,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    after_data
  )
  values (
    reconciliation.company_id,
    'system',
    'scheduling-reconciliation-v1',
    case reconciliation.status
      when 'retry_wait' then 'scheduling_reconciliation.retry_scheduled'
      when 'provider_unknown' then
        'scheduling_reconciliation.provider_state_unknown'
      else 'scheduling_reconciliation.manual_required'
    end,
    'scheduling_reconciliation_case',
    reconciliation.id,
    jsonb_build_object(
      'receiptId', reconciliation.receipt_id,
      'jobId', reconciliation.job_id,
      'errorCode', reconciliation.last_error_code,
      'attemptCount', reconciliation.attempt_count,
      'externalStateUnknown',
        reconciliation.status = 'provider_unknown',
      'manualReviewRequired',
        reconciliation.status = 'manual_required'
    )
  );

  return public.storyops_scheduling_reconciliation_result(reconciliation);
end;
$$;

alter table public.scheduling_reconciliation_cases enable row level security;
alter table public.scheduling_reconciliation_cases force row level security;
alter table public.scheduling_reconciliation_attempts enable row level security;
alter table public.scheduling_reconciliation_attempts force row level security;
alter table public.scheduling_calendar_booking_attempts enable row level security;
alter table public.scheduling_calendar_booking_attempts force row level security;

create policy scheduling_reconciliation_cases_staff_select
on public.scheduling_reconciliation_cases
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
);

create policy scheduling_reconciliation_attempts_staff_select
on public.scheduling_reconciliation_attempts
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
);

create policy scheduling_calendar_booking_attempts_staff_select
on public.scheduling_calendar_booking_attempts
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
);

revoke insert, update, delete
  on table public.scheduling_reconciliation_cases
  from anon, authenticated, service_role;
revoke insert, update, delete
  on table public.scheduling_reconciliation_attempts
  from anon, authenticated, service_role;
revoke insert, update, delete
  on table public.scheduling_calendar_booking_attempts
  from anon, authenticated, service_role;
grant select (
  id,
  schema_version,
  company_id,
  calendar_attempt_id,
  receipt_id,
  job_id,
  status,
  attempt_count,
  max_attempts,
  next_attempt_at,
  last_attempt_at,
  last_error_code,
  claim_operation,
  completed_at,
  created_at,
  updated_at
) on table public.scheduling_reconciliation_cases to authenticated;
grant select on table public.scheduling_reconciliation_attempts to authenticated;
grant select (
  id,
  schema_version,
  company_id,
  job_id,
  job_version,
  property_id,
  crew_id,
  scheduling_idempotency_key,
  calendar_id,
  event_id,
  starts_at,
  ends_at,
  status,
  receipt_id,
  reconcile_after,
  completed_at,
  last_error_code,
  created_at,
  updated_at
) on table public.scheduling_calendar_booking_attempts to authenticated;

revoke all on function private.storyops_calendar_event_id(text)
  from public, anon, authenticated, service_role;
revoke all on function public.storyops_calendar_booking_attempt_json(
  public.scheduling_calendar_booking_attempts, boolean
) from public, anon, authenticated, service_role;
revoke all on function public.prepare_storyops_calendar_booking_attempt(
  uuid, uuid, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.begin_storyops_calendar_booking_provider_call(
  uuid
) from public, anon, authenticated;
revoke all on function public.confirm_storyops_calendar_booking_attempt(
  uuid, text, text
) from public, anon, authenticated;
revoke all on function public.queue_storyops_scheduling_reconciliation()
  from public, anon, authenticated, service_role;
revoke all on function public.close_storyops_consumed_reconciliation()
  from public, anon, authenticated, service_role;
revoke all on function public.fence_storyops_scheduling_consumption()
  from public, anon, authenticated, service_role;
revoke all on function public.storyops_scheduling_reconciliation_result(
  public.scheduling_reconciliation_cases
) from public, anon, authenticated, service_role;
revoke all on function public.claim_storyops_scheduling_reconciliation(
  uuid, uuid, integer
) from public, anon, authenticated;
revoke all on function public.complete_storyops_scheduling_reconciliation(
  uuid, uuid
) from public, anon, authenticated;
revoke all on function public.fail_storyops_scheduling_reconciliation(
  uuid, uuid, text, text, integer
) from public, anon, authenticated;

grant execute on function public.claim_storyops_scheduling_reconciliation(
  uuid, uuid, integer
) to service_role;
grant execute on function public.prepare_storyops_calendar_booking_attempt(
  uuid, uuid, text, text, jsonb
) to service_role;
grant execute on function public.begin_storyops_calendar_booking_provider_call(
  uuid
) to service_role;
grant execute on function public.confirm_storyops_calendar_booking_attempt(
  uuid, text, text
) to service_role;
grant execute on function public.complete_storyops_scheduling_reconciliation(
  uuid, uuid
) to service_role;
grant execute on function public.fail_storyops_scheduling_reconciliation(
  uuid, uuid, text, text, integer
) to service_role;

comment on table public.scheduling_reconciliation_cases is
  'Durable, leased cleanup state for exact expired and unconsumed live scheduling calendar reservations.';
comment on table public.scheduling_reconciliation_attempts is
  'Append-only outcome history for bounded scheduling calendar cleanup attempts.';
comment on table public.scheduling_calendar_booking_attempts is
  'Durable pre-provider outbox for deterministic calendar booking attempts, including provider-unknown attempts that never produced a receipt.';
comment on function public.prepare_storyops_calendar_booking_attempt(
  uuid, uuid, text, text, jsonb
) is
  'Service-only pre-provider boundary that persists exact deterministic calendar identity before any POST.';
comment on function public.begin_storyops_calendar_booking_provider_call(
  uuid
) is
  'Service-only submission boundary that marks provider state unknown before the external calendar call starts.';
comment on function public.confirm_storyops_calendar_booking_attempt(
  uuid, text, text
) is
  'Service-only exact provider read-back recorder; receipt insertion links the attempt transactionally.';
comment on function public.claim_storyops_scheduling_reconciliation(
  uuid, uuid, integer
) is
  'Service-only company-scoped bounded claimant. Expired leases become provider-unknown and deterministic identity mismatches require manual review.';
comment on function public.complete_storyops_scheduling_reconciliation(
  uuid, uuid
) is
  'Service-only completion boundary after exact provider read-back and conditional cancellation.';
comment on function public.fail_storyops_scheduling_reconciliation(
  uuid, uuid, text, text, integer
) is
  'Service-only finite retry, provider-unknown, or manual-required outcome recorder.';
