-- Transactional lead ingress and one authoritative inbound SMS-consent path.
-- The trusted RPC is bound to a signature-verified webhook processing lease;
-- service-role code cannot bypass subject resolution with direct tenant DML.

create or replace function public.storyops_normalize_phone(
  p_phone text
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  with normalized as (
    select
      regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as digits,
      btrim(coalesce(p_phone, '')) as original
  )
  select case
    when length(digits) = 10 then '+1' || digits
    when length(digits) = 11 and left(digits, 1) = '1' then '+' || digits
    when left(original, 1) = '+' and length(digits) between 8 and 15
      then '+' || digits
    else null
  end
  from normalized;
$$;

revoke all on function public.storyops_normalize_phone(text)
  from public, anon, authenticated, service_role;

create table public.contact_suppressions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  channel text not null check (channel in ('sms', 'email', 'voice')),
  contact_fingerprint text not null check (contact_fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active', 'released')),
  reason text not null check (length(btrim(reason)) between 1 and 120),
  source_provider text not null check (length(btrim(source_provider)) between 1 and 80),
  source_event_id text not null check (length(btrim(source_event_id)) between 1 and 255),
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  released_at timestamptz,
  release_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (company_id, channel, contact_fingerprint),
  check (last_observed_at >= first_observed_at),
  check (
    (status = 'active' and released_at is null and release_reason is null)
    or (
      status = 'released'
      and released_at is not null
      and release_reason is not null
      and length(btrim(release_reason)) between 1 and 500
    )
  )
);

create index contact_suppressions_active_idx
  on public.contact_suppressions(company_id, channel, contact_fingerprint)
  where status = 'active';

alter table public.contact_suppressions enable row level security;
alter table public.contact_suppressions force row level security;
revoke all on table public.contact_suppressions
  from public, anon, authenticated, service_role;

comment on table public.contact_suppressions is
  'Hashed contact-level opt-out authority. START never releases a row; release requires a separately reviewed trusted workflow.';

-- Every outbound path already calls this RPC. Preserve the exact prior
-- authorization implementation behind a wrapper that checks contact-level
-- suppression before any subject-scoped grant can be used.
alter function public.authorize_outbound_contact(
  uuid,
  text,
  text,
  text,
  uuid
) rename to authorize_outbound_contact_before_contact_suppression;

revoke all on function public.authorize_outbound_contact_before_contact_suppression(
  uuid,
  text,
  text,
  text,
  uuid
) from public, anon, authenticated, service_role;

create or replace function public.authorize_outbound_contact(
  p_company_id uuid,
  p_channel text,
  p_purpose text,
  p_contact_fingerprint text,
  p_consent_snapshot_id uuid
)
returns table(
  allowed boolean,
  decision_code text,
  consent_record_id uuid,
  latest_consent_record_id uuid
)
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
begin
  if p_company_id is not null
    and p_channel in ('sms', 'email', 'voice')
    and p_contact_fingerprint ~ '^[a-f0-9]{64}$'
    and exists (
      select 1
      from public.contact_suppressions suppression
      where suppression.company_id = p_company_id
        and suppression.channel = p_channel
        and suppression.contact_fingerprint = p_contact_fingerprint
        and suppression.status = 'active'
    )
  then
    return query
      select
        false,
        'OPTED_OUT'::text,
        p_consent_snapshot_id,
        null::uuid;
    return;
  end if;

  return query
    select *
    from public.authorize_outbound_contact_before_contact_suppression(
      p_company_id,
      p_channel,
      p_purpose,
      p_contact_fingerprint,
      p_consent_snapshot_id
    );
end;
$$;

revoke all on function public.authorize_outbound_contact(
  uuid,
  text,
  text,
  text,
  uuid
) from public, anon, authenticated;
grant execute on function public.authorize_outbound_contact(
  uuid,
  text,
  text,
  text,
  uuid
) to service_role;

comment on function public.authorize_outbound_contact(
  uuid,
  text,
  text,
  text,
  uuid
) is
  'Returns a contact-free outbound consent decision after contact-level and exact subject-level suppression checks.';

-- Intake uses a bounded, token-bearing lease. A crashed invocation can be
-- reclaimed, while a stale invocation cannot persist or complete after that
-- reclaim. Other existing webhook consumers retain the legacy RPCs.
alter table public.webhook_events
  add column intake_processing_lease_id uuid,
  add column intake_processing_started_at timestamptz;

create or replace function public.start_storyops_intake_processing(
  p_event_id uuid,
  p_payload_hash text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  lease_id_value uuid := gen_random_uuid();
begin
  update public.webhook_events
  set
    status = 'processing',
    attempt_count = attempt_count + 1,
    last_error = null,
    intake_processing_lease_id = lease_id_value,
    intake_processing_started_at = now()
  where id = p_event_id
    and payload_hash = p_payload_hash
    and (
      status in ('received', 'failed')
      or (
        status = 'processing'
        and (
          intake_processing_started_at is null
          or intake_processing_started_at < now() - interval '5 minutes'
        )
      )
    )
    and attempt_count < 50
    and payload_purged_at is null;
  if not found then
    return null;
  end if;
  return lease_id_value;
end;
$$;

create or replace function public.complete_storyops_intake_webhook(
  p_event_id uuid,
  p_payload_hash text,
  p_processing_lease_id uuid,
  p_disposition text default 'processed'
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_disposition not in ('processed', 'ignored') then
    raise exception 'Webhook disposition must be processed or ignored';
  end if;
  update public.webhook_events
  set
    status = p_disposition,
    processed_at = now(),
    last_error = null,
    intake_processing_lease_id = null,
    intake_processing_started_at = null
  where id = p_event_id
    and payload_hash = p_payload_hash
    and status = 'processing'
    and intake_processing_lease_id = p_processing_lease_id;
  if not found then
    raise exception 'INTAKE_PROCESSING_LEASE_REQUIRED';
  end if;
end;
$$;

create or replace function public.fail_storyops_intake_webhook(
  p_event_id uuid,
  p_payload_hash text,
  p_processing_lease_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.webhook_events
  set
    status = 'failed',
    processed_at = null,
    last_error = left(nullif(btrim(p_error), ''), 2000),
    intake_processing_lease_id = null,
    intake_processing_started_at = null
  where id = p_event_id
    and payload_hash = p_payload_hash
    and status = 'processing'
    and intake_processing_lease_id = p_processing_lease_id;
  if not found then
    raise exception 'INTAKE_PROCESSING_LEASE_REQUIRED';
  end if;
end;
$$;

revoke all on function public.start_storyops_intake_processing(uuid, text)
  from public, anon, authenticated;
revoke all on function public.complete_storyops_intake_webhook(uuid, text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.fail_storyops_intake_webhook(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.start_storyops_intake_processing(uuid, text)
  to service_role;
grant execute on function public.complete_storyops_intake_webhook(uuid, text, uuid, text)
  to service_role;
grant execute on function public.fail_storyops_intake_webhook(uuid, text, uuid, text)
  to service_role;

create or replace function public.persist_storyops_lead_intake(
  p_event_id uuid,
  p_payload_hash text,
  p_company_id uuid,
  p_processing_lease_id uuid,
  p_intake jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  webhook_row public.webhook_events%rowtype;
  provider_value text;
  provider_event_id_value text;
  event_type_value text;
  source_value text;
  occurred_at_value timestamptz;
  display_name_value text;
  email_value text;
  phone_value text;
  normalized_phone_value text;
  preferred_channel_value text;
  consent_signal_value text;
  communication_value jsonb;
  communication_channel_value text;
  sender_value text;
  recipients_value text[];
  body_value text;
  subject_value text;
  provider_message_id_value text;
  consent_value jsonb;
  ids_value jsonb;
  proposed_lead_id uuid;
  proposed_thread_id uuid;
  proposed_message_id uuid;
  requested_services_value text[];
  customer_ids uuid[];
  lead_ids uuid[];
  customer_id_value uuid;
  lead_id_value uuid;
  thread_id_value uuid;
  message_id_value uuid;
  consent_record_id_value uuid;
  message_consent_id uuid;
  consent_record_ids uuid[] := array[]::uuid[];
  consent_channel_value text;
  consent_purpose_value text;
  consent_status_value text;
  capture_method_value text;
  disclosure_version_value text;
  proof_value text;
  withdrawn_at_value timestamptz;
  consent_item jsonb;
  existing_subject_value boolean := true;
  existing_lead_value boolean := false;
  resolution_status_value text;
  contact_suppression_id_value uuid;
  unexpected_key text;
  receipt_value jsonb;
  contact_fingerprint_value text;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'INTAKE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_event_id is null
    or p_company_id is null
    or p_payload_hash is null
    or p_payload_hash !~ '^[a-f0-9]{64}$'
    or p_intake is null
    or jsonb_typeof(p_intake) <> 'object'
  then
    raise exception 'INTAKE_INVALID_ENVELOPE';
  end if;

  select *
  into webhook_row
  from public.webhook_events
  where id = p_event_id
    and company_id = p_company_id
    and payload_hash = p_payload_hash
    and status = 'processing'
    and intake_processing_lease_id = p_processing_lease_id
  for update;
  if not found then
    raise exception 'INTAKE_PROCESSING_LEASE_REQUIRED';
  end if;

  select key
  into unexpected_key
  from jsonb_object_keys(p_intake) keys(key)
  where key <> all(array[
    'schemaVersion', 'provider', 'providerEventId', 'eventType', 'source',
    'occurredAt', 'displayName', 'email', 'phone', 'requestedServices',
    'preferredContactChannel', 'consentSignal', 'communication', 'consent', 'ids'
  ]::text[])
  limit 1;
  if unexpected_key is not null then
    raise exception 'INTAKE_INVALID_UNSUPPORTED_FIELD';
  end if;

  provider_value := nullif(p_intake ->> 'provider', '');
  provider_event_id_value := nullif(p_intake ->> 'providerEventId', '');
  event_type_value := nullif(p_intake ->> 'eventType', '');
  source_value := nullif(p_intake ->> 'source', '');
  display_name_value := nullif(btrim(p_intake ->> 'displayName'), '');
  email_value := nullif(lower(btrim(p_intake ->> 'email')), '');
  phone_value := nullif(btrim(p_intake ->> 'phone'), '');
  normalized_phone_value := public.storyops_normalize_phone(phone_value);
  preferred_channel_value := nullif(p_intake ->> 'preferredContactChannel', '');
  consent_signal_value := coalesce(nullif(p_intake ->> 'consentSignal', ''), 'none');
  communication_value := p_intake -> 'communication';
  consent_value := p_intake -> 'consent';
  ids_value := p_intake -> 'ids';

  begin
    occurred_at_value := (p_intake ->> 'occurredAt')::timestamptz;
    proposed_lead_id := (ids_value ->> 'leadId')::uuid;
    proposed_thread_id := (ids_value ->> 'threadId')::uuid;
    proposed_message_id := (ids_value ->> 'messageId')::uuid;
  exception
    when invalid_text_representation
      or datetime_field_overflow
      or numeric_value_out_of_range
    then
      raise exception 'INTAKE_INVALID_TYPED_VALUE';
  end;

  if p_intake ->> 'schemaVersion' <> 'storyops-lead-intake-v2'
    or provider_value is distinct from webhook_row.provider
    or provider_event_id_value is distinct from webhook_row.provider_event_id
    or event_type_value is distinct from webhook_row.event_type
    or source_value not in ('web', 'chat', 'email', 'sms', 'phone')
    or consent_signal_value not in ('none', 'opt_out', 'opt_in')
    or display_name_value is null
    or length(display_name_value) > 160
    or (email_value is not null and length(email_value) > 320)
    or (phone_value is not null and normalized_phone_value is null)
    or preferred_channel_value is not null
      and preferred_channel_value not in ('email', 'sms', 'phone')
    or occurred_at_value > now() + interval '5 minutes'
    or occurred_at_value < webhook_row.received_at - interval '30 days'
    or communication_value is null
    or jsonb_typeof(communication_value) <> 'object'
    or consent_value is null
    or jsonb_typeof(consent_value) <> 'array'
    or ids_value is null
    or jsonb_typeof(ids_value) <> 'object'
  then
    raise exception 'INTAKE_INVALID_NORMALIZED_EVENT';
  end if;

  select key
  into unexpected_key
  from jsonb_object_keys(communication_value) keys(key)
  where key <> all(array[
    'channel', 'sender', 'recipients', 'body', 'subject', 'providerMessageId'
  ]::text[])
  limit 1;
  if unexpected_key is not null then
    raise exception 'INTAKE_INVALID_COMMUNICATION_FIELD';
  end if;
  select key
  into unexpected_key
  from jsonb_object_keys(ids_value) keys(key)
  where key <> all(array['leadId', 'threadId', 'messageId']::text[])
  limit 1;
  if unexpected_key is not null then
    raise exception 'INTAKE_INVALID_ID_FIELD';
  end if;

  communication_channel_value := nullif(communication_value ->> 'channel', '');
  sender_value := nullif(btrim(communication_value ->> 'sender'), '');
  body_value := nullif(btrim(communication_value ->> 'body'), '');
  subject_value := nullif(btrim(communication_value ->> 'subject'), '');
  provider_message_id_value := nullif(
    btrim(communication_value ->> 'providerMessageId'),
    ''
  );
  if jsonb_typeof(communication_value -> 'recipients') <> 'array' then
    raise exception 'INTAKE_INVALID_RECIPIENTS';
  end if;
  select coalesce(array_agg(value), array[]::text[])
  into recipients_value
  from jsonb_array_elements_text(communication_value -> 'recipients') values(value);

  if communication_channel_value not in ('sms', 'email', 'voice', 'chat')
    or sender_value is null
    or length(sender_value) > 320
    or body_value is null
    or length(body_value) > 8000
    or subject_value is not null and length(subject_value) > 300
    or provider_message_id_value is null
    or length(provider_message_id_value) > 255
    or cardinality(recipients_value) > 10
    or exists (
      select 1
      from unnest(recipients_value) recipient
      where length(btrim(recipient)) not between 1 and 320
    )
    or jsonb_array_length(consent_value) > 6
  then
    raise exception 'INTAKE_INVALID_COMMUNICATION';
  end if;

  if jsonb_typeof(p_intake -> 'requestedServices') <> 'array'
    or jsonb_array_length(p_intake -> 'requestedServices') > 12
  then
    raise exception 'INTAKE_INVALID_REQUESTED_SERVICES';
  end if;
  select coalesce(array_agg(distinct value order by value), array[]::text[])
  into requested_services_value
  from jsonb_array_elements_text(p_intake -> 'requestedServices') values(value);
  if exists (
    select 1
    from unnest(requested_services_value) service_code
    where service_code !~ '^[a-z0-9][a-z0-9_-]{0,79}$'
  ) then
    raise exception 'INTAKE_INVALID_REQUESTED_SERVICES';
  end if;

  if source_value = 'sms' then
    if provider_value <> 'twilio'
      or event_type_value <> 'inbound_message'
      or provider_event_id_value !~ '^SM[0-9A-Za-z]+:inbound_message$'
      or communication_channel_value <> 'sms'
      or normalized_phone_value is null
      or public.storyops_normalize_phone(sender_value) is distinct from normalized_phone_value
    then
      raise exception 'INTAKE_INVALID_TWILIO_SMS';
    end if;
  elsif source_value = 'phone' then
    if provider_value <> 'twilio'
      or event_type_value <> 'inbound_voice'
      or provider_event_id_value !~ '^CA[0-9A-Za-z]+$'
      or communication_channel_value <> 'voice'
      or consent_signal_value <> 'none'
      or normalized_phone_value is null
    then
      raise exception 'INTAKE_INVALID_TWILIO_VOICE';
    end if;
  elsif provider_value <> ('storyops_' || source_value)
    or event_type_value <> ('inbound_' || source_value)
    or communication_channel_value is distinct from (
      case when source_value = 'email' then 'email' else 'chat' end
    )
    or consent_signal_value <> 'none'
  then
    raise exception 'INTAKE_INVALID_SIGNED_SOURCE';
  end if;

  if consent_signal_value in ('opt_out', 'opt_in') then
    if source_value <> 'sms'
      or jsonb_array_length(consent_value) <> 2
      or (
        select count(distinct item ->> 'purpose')
        from jsonb_array_elements(consent_value) items(item)
        where item ->> 'channel' = 'sms'
          and item ->> 'purpose' in ('transactional', 'marketing')
      ) <> 2
    then
      raise exception 'INTAKE_INVALID_CONSENT_KEYWORD';
    end if;
  end if;

  if normalized_phone_value is not null then
    contact_fingerprint_value := encode(
      extensions.digest(normalized_phone_value, 'sha256'),
      'hex'
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      p_company_id::text || '|' || coalesce(email_value, '') || '|' ||
        coalesce(
          normalized_phone_value,
          case when email_value is null then provider_event_id_value else '' end
        ),
      0
    )
  );

  if consent_signal_value = 'opt_out' then
    insert into public.contact_suppressions(
      company_id,
      channel,
      contact_fingerprint,
      status,
      reason,
      source_provider,
      source_event_id,
      first_observed_at,
      last_observed_at
    )
    values (
      p_company_id,
      'sms',
      contact_fingerprint_value,
      'active',
      'sms_keyword_opt_out',
      provider_value,
      provider_event_id_value,
      occurred_at_value,
      occurred_at_value
    )
    on conflict (company_id, channel, contact_fingerprint)
    do update
    set
      status = 'active',
      reason = excluded.reason,
      source_provider = excluded.source_provider,
      source_event_id = excluded.source_event_id,
      first_observed_at = least(
        public.contact_suppressions.first_observed_at,
        excluded.first_observed_at
      ),
      last_observed_at = greatest(
        public.contact_suppressions.last_observed_at,
        excluded.last_observed_at
      ),
      released_at = null,
      release_reason = null,
      updated_at = now(),
      version = public.contact_suppressions.version + 1
    returning id into contact_suppression_id_value;
  end if;

  select array_agg(candidate.id order by candidate.id)
  into customer_ids
  from (
    select customer.id
    from public.customers customer
    where customer.company_id = p_company_id
      and (
        (email_value is not null and lower(customer.email::text) = email_value)
        or (
          normalized_phone_value is not null
          and public.storyops_normalize_phone(customer.phone) = normalized_phone_value
        )
      )
    union
    select linked_customer.id
    from public.leads converted_lead
    join public.customers linked_customer
      on linked_customer.id = converted_lead.customer_id
      and linked_customer.company_id = converted_lead.company_id
    where converted_lead.company_id = p_company_id
      and converted_lead.status = 'converted'
      and (
        (email_value is not null and lower(converted_lead.email::text) = email_value)
        or (
          normalized_phone_value is not null
          and public.storyops_normalize_phone(converted_lead.phone) = normalized_phone_value
        )
      )
  ) candidate;

  select array_agg(lead.id order by lead.id)
  into lead_ids
  from public.leads lead
  where lead.company_id = p_company_id
    and (
      (email_value is not null and lower(lead.email::text) = email_value)
      or (
        normalized_phone_value is not null
        and public.storyops_normalize_phone(lead.phone) = normalized_phone_value
      )
    )
    and not (
      lead.status = 'converted'
      and lead.customer_id is not null
      and lead.customer_id = any(coalesce(customer_ids, array[]::uuid[]))
    );

  if coalesce(cardinality(customer_ids), 0) = 1
    and coalesce(cardinality(lead_ids), 0) = 0
  then
    customer_id_value := customer_ids[1];
  elsif coalesce(cardinality(customer_ids), 0) = 0
    and coalesce(cardinality(lead_ids), 0) = 1
  then
    lead_id_value := lead_ids[1];
    existing_lead_value := true;
  elsif coalesce(cardinality(customer_ids), 0) = 0
    and coalesce(cardinality(lead_ids), 0) = 0
  then
    if consent_signal_value = 'opt_out' then
      existing_subject_value := false;
      resolution_status_value := 'not_found';
    elsif consent_signal_value = 'opt_in' then
      raise exception 'INTAKE_CONSENT_SUBJECT_NOT_FOUND';
    else
      existing_subject_value := false;
      lead_id_value := proposed_lead_id;
      insert into public.leads(
        id,
        company_id,
        source,
        status,
        display_name,
        email,
        phone,
        requested_services,
        preferred_contact_channel
      )
      values (
        lead_id_value,
        p_company_id,
        source_value,
        'new',
        display_name_value,
        email_value,
        normalized_phone_value,
        requested_services_value,
        preferred_channel_value
      )
      on conflict (id) do nothing;
      if not exists (
        select 1
        from public.leads
        where id = lead_id_value
          and company_id = p_company_id
      ) then
        raise exception 'INTAKE_INVALID_LEAD_ID_CONFLICT';
      end if;
    end if;
  else
    if consent_signal_value = 'opt_out' then
      resolution_status_value := 'ambiguous';
    else
      raise exception 'INTAKE_SUBJECT_AMBIGUOUS';
    end if;
  end if;

  if resolution_status_value is not null then
    update public.customers
    set
      do_not_contact = true,
      updated_at = now(),
      version = version + 1
    where company_id = p_company_id
      and id = any(coalesce(customer_ids, array[]::uuid[]))
      and not do_not_contact;

    receipt_value := jsonb_build_object(
      'subjectType', 'contact',
      'customerId', null,
      'leadId', null,
      'threadId', null,
      'messageId', null,
      'consentRecordIds', jsonb_build_array(),
      'existingSubject', existing_subject_value,
      'existingLead', false,
      'consentSignal', consent_signal_value,
      'contactSuppressed', true,
      'contactSuppressionId', contact_suppression_id_value,
      'resolutionStatus', resolution_status_value,
      'customerCandidateCount', coalesce(cardinality(customer_ids), 0),
      'leadCandidateCount', coalesce(cardinality(lead_ids), 0)
    );

    update public.webhook_events
    set payload = payload || jsonb_build_object('intakeReceipt', receipt_value)
    where id = p_event_id
      and company_id = p_company_id
      and payload_hash = p_payload_hash
      and status = 'processing'
      and intake_processing_lease_id = p_processing_lease_id;
    if not found then
      raise exception 'INTAKE_PROCESSING_LEASE_REQUIRED';
    end if;

    if not exists (
      select 1
      from public.audit_events
      where company_id = p_company_id
        and request_id = p_event_id::text
        and actor_type = 'provider'
        and actor_id = provider_value
        and action = 'lead_intake_contact_suppressed'
    ) then
      insert into public.audit_events(
        company_id,
        occurred_at,
        actor_type,
        actor_id,
        action,
        entity_type,
        entity_id,
        before_data,
        after_data,
        request_id,
        retention_class,
        retain_until
      )
      values (
        p_company_id,
        now(),
        'provider',
        provider_value,
        'lead_intake_contact_suppressed',
        'contact_suppression',
        contact_suppression_id_value,
        null,
        jsonb_build_object(
          'consentSignal', consent_signal_value,
          'resolutionStatus', resolution_status_value,
          'customerCandidateCount', coalesce(cardinality(customer_ids), 0),
          'leadCandidateCount', coalesce(cardinality(lead_ids), 0)
        ),
        p_event_id::text,
        'audit',
        now() + interval '7 years'
      );
    end if;

    return receipt_value;
  end if;

  if lead_id_value is not null and existing_lead_value then
    update public.leads
    set
      email = coalesce(email, email_value),
      phone = coalesce(phone, normalized_phone_value),
      requested_services = (
        select coalesce(array_agg(distinct service_code order by service_code), array[]::text[])
        from unnest(requested_services || requested_services_value) service(service_code)
      ),
      preferred_contact_channel = coalesce(
        preferred_contact_channel,
        preferred_channel_value
      ),
      updated_at = now(),
      version = version + 1
    where id = lead_id_value
      and company_id = p_company_id
      and (
        (email is null and email_value is not null)
        or (phone is null and normalized_phone_value is not null)
        or not requested_services @> requested_services_value
        or (
          preferred_contact_channel is null
          and preferred_channel_value is not null
        )
      );
  end if;

  if consent_signal_value = 'opt_out' and customer_id_value is not null then
    update public.customers
    set
      do_not_contact = true,
      updated_at = now(),
      version = version + 1
    where id = customer_id_value
      and company_id = p_company_id
      and not do_not_contact;
  end if;

  for consent_item in
    select item
    from jsonb_array_elements(consent_value) items(item)
  loop
    select key
    into unexpected_key
    from jsonb_object_keys(consent_item) keys(key)
    where key <> all(array[
      'id', 'channel', 'purpose', 'status', 'captureMethod',
      'disclosureVersion', 'proof'
    ]::text[])
    limit 1;
    if unexpected_key is not null then
      raise exception 'INTAKE_INVALID_CONSENT_FIELD';
    end if;
    begin
      consent_record_id_value := (consent_item ->> 'id')::uuid;
    exception
      when invalid_text_representation then
        raise exception 'INTAKE_INVALID_CONSENT_ID';
    end;
    consent_channel_value := nullif(consent_item ->> 'channel', '');
    consent_purpose_value := nullif(consent_item ->> 'purpose', '');
    consent_status_value := nullif(consent_item ->> 'status', '');
    capture_method_value := nullif(consent_item ->> 'captureMethod', '');
    disclosure_version_value := nullif(
      btrim(consent_item ->> 'disclosureVersion'),
      ''
    );
    proof_value := nullif(btrim(consent_item ->> 'proof'), '');

    if consent_signal_value in ('opt_out', 'opt_in') then
      consent_channel_value := 'sms';
      consent_status_value := case
        when consent_signal_value = 'opt_out' then 'withdrawn'
        else 'unknown'
      end;
      capture_method_value := 'keyword';
      disclosure_version_value := case
        when consent_signal_value = 'opt_out' then 'sms-keyword-v1'
        else 'sms-keyword-review-v1'
      end;
      proof_value :=
        'provider=twilio;event=' || provider_event_id_value ||
        ';contact_sha256=' || contact_fingerprint_value;
    end if;

    if consent_channel_value not in ('sms', 'email', 'voice')
      or consent_purpose_value not in ('transactional', 'marketing')
      or consent_status_value not in ('granted', 'withdrawn', 'unknown')
      or capture_method_value not in (
        'web_form', 'keyword', 'written', 'verbal', 'imported'
      )
      or disclosure_version_value is null
      or length(disclosure_version_value) > 80
      or proof_value is null
      or length(proof_value) > 2000
    then
      raise exception 'INTAKE_INVALID_CONSENT_RECORD';
    end if;
    withdrawn_at_value := case
      when consent_status_value = 'withdrawn' then occurred_at_value
      else null
    end;

    insert into public.consent_records(
      id,
      company_id,
      customer_id,
      lead_id,
      channel,
      purpose,
      status,
      captured_at,
      capture_method,
      disclosure_version,
      proof,
      withdrawn_at
    )
    values (
      consent_record_id_value,
      p_company_id,
      customer_id_value,
      lead_id_value,
      consent_channel_value,
      consent_purpose_value,
      consent_status_value,
      occurred_at_value,
      capture_method_value,
      disclosure_version_value,
      proof_value,
      withdrawn_at_value
    )
    on conflict (id) do nothing;

    if not exists (
      select 1
      from public.consent_records consent
      where consent.id = consent_record_id_value
        and consent.company_id = p_company_id
        and consent.customer_id is not distinct from customer_id_value
        and consent.lead_id is not distinct from lead_id_value
        and consent.channel = consent_channel_value
        and consent.purpose = consent_purpose_value
        and consent.status = consent_status_value
        and consent.proof = proof_value
    ) then
      raise exception 'INTAKE_INVALID_CONSENT_ID_CONFLICT';
    end if;
    consent_record_ids := array_append(
      consent_record_ids,
      consent_record_id_value
    );
    if consent_channel_value = communication_channel_value
      and consent_purpose_value = 'transactional'
    then
      message_consent_id := consent_record_id_value;
    end if;
  end loop;

  select thread.id
  into thread_id_value
  from public.communication_threads thread
  where thread.company_id = p_company_id
    and thread.status = 'open'
    and (
      (customer_id_value is not null and thread.customer_id = customer_id_value)
      or (lead_id_value is not null and thread.lead_id = lead_id_value)
    )
  order by thread.last_message_at desc, thread.id
  limit 1
  for update;

  if thread_id_value is null then
    thread_id_value := proposed_thread_id;
    insert into public.communication_threads(
      id,
      company_id,
      customer_id,
      lead_id,
      subject,
      status,
      last_message_at
    )
    values (
      thread_id_value,
      p_company_id,
      customer_id_value,
      lead_id_value,
      subject_value,
      'open',
      occurred_at_value
    )
    on conflict (id) do nothing;
    if not exists (
      select 1
      from public.communication_threads
      where id = thread_id_value
        and company_id = p_company_id
        and customer_id is not distinct from customer_id_value
        and lead_id is not distinct from lead_id_value
    ) then
      raise exception 'INTAKE_INVALID_THREAD_ID_CONFLICT';
    end if;
  end if;

  message_id_value := proposed_message_id;
  insert into public.communication_messages(
    id,
    company_id,
    thread_id,
    channel,
    direction,
    sender,
    recipients,
    body,
    risk_class,
    provider_message_id,
    delivery_status,
    consent_record_id,
    received_at,
    retention_class
  )
  values (
    message_id_value,
    p_company_id,
    thread_id_value,
    communication_channel_value,
    'inbound',
    sender_value,
    recipients_value,
    body_value,
    'routine',
    provider_message_id_value,
    'received',
    message_consent_id,
    occurred_at_value,
    'communication'
  )
  on conflict (id) do nothing;
  if not exists (
    select 1
    from public.communication_messages message
    where message.id = message_id_value
      and message.company_id = p_company_id
      and message.thread_id = thread_id_value
      and message.direction = 'inbound'
      and message.provider_message_id = provider_message_id_value
  ) then
    raise exception 'INTAKE_INVALID_MESSAGE_ID_CONFLICT';
  end if;

  update public.communication_threads
  set
    last_message_at = greatest(last_message_at, occurred_at_value),
    updated_at = now(),
    version = version + 1
  where id = thread_id_value
    and company_id = p_company_id
    and last_message_at < occurred_at_value;

  receipt_value := jsonb_build_object(
    'subjectType', case
      when customer_id_value is not null then 'customer'
      else 'lead'
    end,
    'customerId', customer_id_value,
    'leadId', lead_id_value,
    'threadId', thread_id_value,
    'messageId', message_id_value,
    'consentRecordIds', to_jsonb(consent_record_ids),
    'existingSubject', existing_subject_value,
    'existingLead', existing_lead_value,
    'consentSignal', consent_signal_value
  );

  update public.webhook_events
  set payload = payload || jsonb_build_object('intakeReceipt', receipt_value)
  where id = p_event_id
    and company_id = p_company_id
    and payload_hash = p_payload_hash
    and status = 'processing'
    and intake_processing_lease_id = p_processing_lease_id;
  if not found then
    raise exception 'INTAKE_PROCESSING_LEASE_REQUIRED';
  end if;

  if not exists (
    select 1
    from public.audit_events
    where company_id = p_company_id
      and request_id = p_event_id::text
      and actor_type = 'provider'
      and actor_id = provider_value
      and action = 'lead_intake_persisted'
  ) then
    insert into public.audit_events(
      company_id,
      occurred_at,
      actor_type,
      actor_id,
      action,
      entity_type,
      entity_id,
      before_data,
      after_data,
      request_id,
      retention_class,
      retain_until
    )
    values (
      p_company_id,
      now(),
      'provider',
      provider_value,
      'lead_intake_persisted',
      case when customer_id_value is not null then 'customer' else 'lead' end,
      coalesce(customer_id_value, lead_id_value),
      null,
      jsonb_build_object(
        'subjectType', receipt_value ->> 'subjectType',
        'consentSignal', consent_signal_value,
        'messageId', message_id_value
      ),
      p_event_id::text,
      'audit',
      now() + interval '7 years'
    );
  end if;

  return receipt_value;
end;
$$;

create or replace function public.load_storyops_lead_intake_receipt(
  p_event_id uuid,
  p_payload_hash text,
  p_company_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  receipt_value jsonb;
begin
  if auth.role() is distinct from 'service_role'
    and session_user <> 'postgres'
  then
    raise exception 'INTAKE_SERVICE_ROLE_REQUIRED';
  end if;
  select webhook.payload -> 'intakeReceipt'
  into receipt_value
  from public.webhook_events webhook
  where webhook.id = p_event_id
    and webhook.company_id = p_company_id
    and webhook.payload_hash = p_payload_hash
    and webhook.status in ('processing', 'processed');
  if receipt_value is null or jsonb_typeof(receipt_value) <> 'object' then
    raise exception 'INTAKE_RECEIPT_NOT_FOUND';
  end if;
  return receipt_value;
end;
$$;

revoke all on function public.persist_storyops_lead_intake(
  uuid,
  text,
  uuid,
  uuid,
  jsonb
) from public, anon, authenticated;
grant execute on function public.persist_storyops_lead_intake(
  uuid,
  text,
  uuid,
  uuid,
  jsonb
) to service_role;

revoke all on function public.load_storyops_lead_intake_receipt(
  uuid,
  text,
  uuid
) from public, anon, authenticated;
grant execute on function public.load_storyops_lead_intake_receipt(
  uuid,
  text,
  uuid
) to service_role;

comment on function public.persist_storyops_lead_intake(
  uuid,
  text,
  uuid,
  uuid,
  jsonb
) is
  'Persists verified inbound communication under an exact intake lease; unresolved STOP still commits contact-level suppression and a non-content quarantine receipt.';
comment on function public.load_storyops_lead_intake_receipt(
  uuid,
  text,
  uuid
) is
  'Returns only the durable non-content receipt for an already persisted lead-intake webhook.';

-- Remove the legacy service-role path that could separately mutate Twilio
-- keyword consent. All inbound messages now use persist_storyops_lead_intake.
alter function public.reconcile_provider_webhook(
  uuid,
  text,
  uuid,
  text,
  jsonb
) rename to reconcile_provider_webhook_before_intake_guard;

revoke all on function public.reconcile_provider_webhook_before_intake_guard(
  uuid,
  text,
  uuid,
  text,
  jsonb
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
set search_path = pg_catalog, public
as $$
begin
  if p_provider = 'twilio'
    and p_reconciliation ->> 'eventType' = 'inbound_message'
  then
    raise exception 'TWILIO_INBOUND_REQUIRES_LEAD_INTAKE';
  end if;
  return public.reconcile_provider_webhook_before_intake_guard(
    p_event_id,
    p_payload_hash,
    p_company_id,
    p_provider,
    p_reconciliation
  );
end;
$$;

revoke all on function public.reconcile_provider_webhook(
  uuid,
  text,
  uuid,
  text,
  jsonb
) from public, anon, authenticated;
grant execute on function public.reconcile_provider_webhook(
  uuid,
  text,
  uuid,
  text,
  jsonb
) to service_role;

comment on function public.reconcile_provider_webhook(
  uuid,
  text,
  uuid,
  text,
  jsonb
) is
  'Reconciles delivery/payment callbacks; verified Twilio inbound messages are exclusively handled by the transactional lead-intake RPC.';
