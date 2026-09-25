-- Trusted operational classification for verified inbound lead intake.
--
-- Business-hours state is derived only from the current immutable published
-- company configuration. Message content can select only a finite handoff
-- reason set; it is never executed or copied into notifications/audit evidence.
-- Status-qualified Twilio missed-call event IDs are collapsed to one recovery
-- action per provider call while retaining distinct webhook replay keys.

create table public.lead_intake_operational_dispositions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  webhook_event_id uuid not null references public.webhook_events(id) on delete restrict,
  message_id uuid not null references public.communication_messages(id) on delete restrict,
  lead_id uuid references public.leads(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete restrict,
  published_configuration_id uuid
    references public.company_configuration_versions(id) on delete restrict,
  source_operation_key text not null
    check (length(btrim(source_operation_key)) between 1 and 600),
  disposition text not null check (disposition in (
    'routine',
    'after_hours',
    'missed_call_recovery',
    'human_handoff_required'
  )),
  business_hours_status text not null check (business_hours_status in (
    'open',
    'closed',
    'configuration_missing'
  )),
  business_timezone text,
  business_local_occurred_at timestamp without time zone,
  missed_call boolean not null default false,
  terminal_call_status text check (
    terminal_call_status is null
    or terminal_call_status in ('no-answer', 'busy', 'failed', 'canceled')
  ),
  human_handoff_required boolean not null default false,
  handoff_reasons text[] not null default '{}'
    check (
      handoff_reasons <@ array[
        'explicit_human_request',
        'legal_uncertainty',
        'safety_uncertainty',
        'emergency_uncertainty',
        'business_hours_configuration_missing'
      ]::text[]
    ),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  retention_class text not null default 'audit' check (retention_class = 'audit'),
  retain_until timestamptz not null default (now() + interval '7 years'),
  unique (company_id, webhook_event_id),
  unique (company_id, message_id),
  unique (company_id, source_operation_key),
  check (num_nonnulls(lead_id, customer_id) = 1),
  check (missed_call = (terminal_call_status is not null)),
  check (human_handoff_required = (cardinality(handoff_reasons) > 0)),
  check (
    (business_hours_status = 'configuration_missing'
      and published_configuration_id is null
      and business_timezone is null
      and business_local_occurred_at is null)
    or
    (business_hours_status in ('open', 'closed')
      and published_configuration_id is not null
      and business_timezone is not null
      and business_local_occurred_at is not null)
  )
);

create index lead_intake_operational_dispositions_company_created_idx
  on public.lead_intake_operational_dispositions(company_id, created_at desc);
create index lead_intake_operational_dispositions_owner_queue_idx
  on public.lead_intake_operational_dispositions(
    company_id,
    disposition,
    created_at desc
  )
  where disposition <> 'routine';

create or replace function public.record_storyops_lead_intake_operational_disposition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  receipt_value jsonb := new.payload -> 'intakeReceipt';
  message_id_value uuid;
  message_row public.communication_messages%rowtype;
  thread_row public.communication_threads%rowtype;
  configuration_row public.company_configuration_versions%rowtype;
  timezone_value text;
  local_occurred_at_value timestamp without time zone;
  local_day_value text;
  local_time_value time without time zone;
  business_day_value jsonb;
  opens_at_value time without time zone;
  closes_at_value time without time zone;
  business_hours_status_value text := 'configuration_missing';
  terminal_call_status_value text;
  original_call_sid_value text;
  missed_call_value boolean := false;
  consent_signal_value text;
  handoff_reasons_value text[] := array[]::text[];
  handoff_required_value boolean := false;
  disposition_value text;
  source_operation_key_value text;
  disposition_id_value uuid;
  evidence_value jsonb;
  recipient record;
begin
  if receipt_value is null
    or jsonb_typeof(receipt_value) <> 'object'
    or nullif(receipt_value ->> 'messageId', '') is null
    or old.payload -> 'intakeReceipt' is not distinct from receipt_value
  then
    return new;
  end if;

  begin
    message_id_value := (receipt_value ->> 'messageId')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'LEAD_INTAKE_OPERATIONAL_INVALID_MESSAGE_ID';
  end;

  select message.*
  into message_row
  from public.communication_messages message
  where message.id = message_id_value
    and message.company_id = new.company_id
    and message.direction = 'inbound'
    and message.delivery_status = 'received';
  if not found then
    raise exception 'LEAD_INTAKE_OPERATIONAL_MESSAGE_NOT_FOUND';
  end if;

  select thread.*
  into thread_row
  from public.communication_threads thread
  where thread.id = message_row.thread_id
    and thread.company_id = new.company_id;
  if not found
    or num_nonnulls(thread_row.lead_id, thread_row.customer_id) <> 1
  then
    raise exception 'LEAD_INTAKE_OPERATIONAL_SUBJECT_INVALID';
  end if;
  if (
    thread_row.lead_id is not null
    and not exists (
      select 1
      from public.leads lead
      where lead.id = thread_row.lead_id
        and lead.company_id = new.company_id
    )
  ) or (
    thread_row.customer_id is not null
    and not exists (
      select 1
      from public.customers customer
      where customer.id = thread_row.customer_id
        and customer.company_id = new.company_id
    )
  ) then
    raise exception 'LEAD_INTAKE_OPERATIONAL_SUBJECT_SCOPE_MISMATCH';
  end if;

  -- The configuration row is immutable once published. Invalid or absent
  -- timezone/hours data fails closed to an owner handoff; it never defaults to
  -- a guessed timezone or assumed availability.
  select configuration.*
  into configuration_row
  from public.company_configuration_versions configuration
  where configuration.company_id = new.company_id
    and configuration.status = 'published'
  order by configuration.revision desc
  limit 1;

  if found then
    timezone_value := nullif(
      btrim(configuration_row.configuration #>> '{territory,timezone}'),
      ''
    );
    if timezone_value is not null
      and exists (
        select 1
        from pg_catalog.pg_timezone_names timezone_record
        where timezone_record.name = timezone_value
      )
      and jsonb_typeof(
        configuration_row.configuration #> '{schedule,businessHours}'
      ) = 'array'
    then
      local_occurred_at_value := message_row.received_at at time zone timezone_value;
      local_day_value := lower(
        btrim(to_char(local_occurred_at_value, 'FMDay'))
      );
      local_time_value := local_occurred_at_value::time;

      select day_record
      into business_day_value
      from jsonb_array_elements(
        configuration_row.configuration #> '{schedule,businessHours}'
      ) day_records(day_record)
      where day_record ->> 'day' = local_day_value
      limit 1;

      if business_day_value is not null
        and jsonb_typeof(business_day_value -> 'closed') = 'boolean'
        and business_day_value ->> 'opensAt' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        and business_day_value ->> 'closesAt' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      then
        opens_at_value := (business_day_value ->> 'opensAt')::time;
        closes_at_value := (business_day_value ->> 'closesAt')::time;
        if (business_day_value ->> 'closed')::boolean
          or opens_at_value >= closes_at_value
          or local_time_value < opens_at_value
          or local_time_value >= closes_at_value
        then
          business_hours_status_value := 'closed';
        else
          business_hours_status_value := 'open';
        end if;
      end if;
    end if;
  end if;

  -- Terminal provider states have distinct durable event keys, while all
  -- statuses for one CallSid share a single owner recovery action.
  if new.provider = 'twilio'
    and new.event_type = 'inbound_voice'
    and message_row.channel = 'voice'
    and new.provider_event_id ~ '^CA[0-9A-Za-z]+MCR(NOANSWER|BUSY|FAILED|CANCELED)$'
  then
    terminal_call_status_value := case
      when new.provider_event_id ~ 'MCRNOANSWER$' then 'no-answer'
      when new.provider_event_id ~ 'MCRBUSY$' then 'busy'
      when new.provider_event_id ~ 'MCRFAILED$' then 'failed'
      when new.provider_event_id ~ 'MCRCANCELED$' then 'canceled'
    end;
    original_call_sid_value := regexp_replace(
      new.provider_event_id,
      'MCR(NOANSWER|BUSY|FAILED|CANCELED)$',
      ''
    );
    missed_call_value := terminal_call_status_value is not null
      and message_row.body =
        '[Missed inbound voice call; terminal provider status ' ||
        terminal_call_status_value ||
        '; transcript intentionally not used]';
    if not missed_call_value then
      raise exception 'LEAD_INTAKE_OPERATIONAL_MISSED_CALL_EVIDENCE_MISMATCH';
    end if;
  end if;

  -- STOP/START are consent state transitions and never content-driven handoff
  -- requests. Other content is matched only against fixed risk/request phrases.
  consent_signal_value := coalesce(receipt_value ->> 'consentSignal', 'none');
  if consent_signal_value not in ('none', 'opt_out', 'opt_in') then
    raise exception 'LEAD_INTAKE_OPERATIONAL_CONSENT_SIGNAL_INVALID';
  end if;
  if consent_signal_value = 'none' and not missed_call_value
  then
    if lower(message_row.body)
      ~ '(^|[^[:alnum:]_])(speak|talk|connect|transfer|chat)([^[:alnum:]_].{0,48})?(human|person|representative|agent|owner|manager)([^[:alnum:]_]|$)'
      or lower(message_row.body)
      ~ '(^|[^[:alnum:]_])(real person|live agent|human help|call me|have someone call|need a person)([^[:alnum:]_]|$)'
    then
      handoff_reasons_value := array_append(
        handoff_reasons_value,
        'explicit_human_request'
      );
    end if;
    if lower(message_row.body)
      ~ '(^|[^[:alnum:]_])(legal|lawyer|attorney|lawsuit|sue|suing|liability|claim adjuster)([^[:alnum:]_]|$)'
    then
      handoff_reasons_value := array_append(
        handoff_reasons_value,
        'legal_uncertainty'
      );
    end if;
    if lower(message_row.body)
      ~ '(^|[^[:alnum:]_])(unsafe|safety|injury|injured|chemical burn|chemical exposure|bleach exposure|poison|electrocution|property damage)([^[:alnum:]_]|$)'
    then
      handoff_reasons_value := array_append(
        handoff_reasons_value,
        'safety_uncertainty'
      );
    end if;
    if lower(message_row.body)
      ~ '(^|[^[:alnum:]_])(911|emergency|ambulance|fire department|medical emergency|life threatening)([^[:alnum:]_]|$)'
    then
      handoff_reasons_value := array_append(
        handoff_reasons_value,
        'emergency_uncertainty'
      );
    end if;
  end if;

  if business_hours_status_value = 'configuration_missing'
    and consent_signal_value = 'none'
  then
    handoff_reasons_value := array_append(
      handoff_reasons_value,
      'business_hours_configuration_missing'
    );
  end if;
  handoff_required_value := cardinality(handoff_reasons_value) > 0;

  disposition_value := case
    when missed_call_value then 'missed_call_recovery'
    when consent_signal_value <> 'none' then 'routine'
    when handoff_required_value then 'human_handoff_required'
    when business_hours_status_value = 'closed' then 'after_hours'
    else 'routine'
  end;
  source_operation_key_value := case
    when missed_call_value then
      'twilio:' || original_call_sid_value || ':missed_call'
    else
      new.provider || ':' || new.provider_event_id
  end;

  evidence_value := jsonb_build_object(
    'schemaVersion', 'storyops-lead-intake-operations-v1',
    'businessHours', jsonb_build_object(
      'authority', 'published_company_configuration',
      'status', business_hours_status_value,
      'configurationId', case
        when business_hours_status_value = 'configuration_missing' then null
        else configuration_row.id
      end,
      'configurationRevision', case
        when business_hours_status_value = 'configuration_missing' then null
        else configuration_row.revision
      end,
      'configurationHash', case
        when business_hours_status_value = 'configuration_missing' then null
        else configuration_row.configuration_hash
      end,
      'timezone', case
        when business_hours_status_value = 'configuration_missing' then null
        else timezone_value
      end,
      'localOccurredAt', case
        when business_hours_status_value = 'configuration_missing' then null
        else local_occurred_at_value
      end,
      'localDay', case
        when business_hours_status_value = 'configuration_missing' then null
        else local_day_value
      end,
      'opensAt', case
        when business_hours_status_value = 'configuration_missing' then null
        else business_day_value ->> 'opensAt'
      end,
      'closesAt', case
        when business_hours_status_value = 'configuration_missing' then null
        else business_day_value ->> 'closesAt'
      end
    ),
    'provider', jsonb_build_object(
      'provider', new.provider,
      'eventType', new.event_type,
      'eventId', new.provider_event_id,
      'terminalCallStatus', terminal_call_status_value
    ),
    'handoff', jsonb_build_object(
      'classifierVersion', 'storyops-intake-handoff-v1',
      'required', handoff_required_value,
      'reasons', to_jsonb(handoff_reasons_value),
      'consentTransition', consent_signal_value <> 'none'
    )
  );

  insert into public.lead_intake_operational_dispositions(
    company_id,
    webhook_event_id,
    message_id,
    lead_id,
    customer_id,
    published_configuration_id,
    source_operation_key,
    disposition,
    business_hours_status,
    business_timezone,
    business_local_occurred_at,
    missed_call,
    terminal_call_status,
    human_handoff_required,
    handoff_reasons,
    evidence
  )
  values (
    new.company_id,
    new.id,
    message_row.id,
    thread_row.lead_id,
    thread_row.customer_id,
    case
      when business_hours_status_value = 'configuration_missing' then null
      else configuration_row.id
    end,
    source_operation_key_value,
    disposition_value,
    business_hours_status_value,
    case
      when business_hours_status_value = 'configuration_missing' then null
      else timezone_value
    end,
    case
      when business_hours_status_value = 'configuration_missing' then null
      else local_occurred_at_value
    end,
    missed_call_value,
    terminal_call_status_value,
    handoff_required_value,
    handoff_reasons_value,
    evidence_value
  )
  on conflict (company_id, source_operation_key) do nothing
  returning id into disposition_id_value;

  -- A second terminal state for one call remains durable as its own webhook and
  -- inbound communication, but does not create a duplicate recovery action.
  if disposition_id_value is null then
    return new;
  end if;

  if disposition_value <> 'routine' then
    for recipient in
      select membership.user_id
      from public.company_memberships membership
      where membership.company_id = new.company_id
        and membership.active
        and membership.role in ('owner', 'dispatcher')
      order by
        case when membership.role = 'owner' then 0 else 1 end,
        membership.user_id
    loop
      insert into public.notifications(
        company_id,
        recipient_user_id,
        kind,
        title,
        body,
        action_url
      )
      values (
        new.company_id,
        recipient.user_id,
        'system',
        case disposition_value
          when 'missed_call_recovery' then 'Missed call needs recovery'
          when 'after_hours' then 'After-hours lead received'
          else 'Human follow-up required'
        end,
        case
          when handoff_reasons_value @> array['emergency_uncertainty']::text[]
            then 'A verified inbound message mentioned an emergency. Review the lead immediately; WashOps did not send advice.'
          when handoff_reasons_value @> array['business_hours_configuration_missing']::text[]
            then 'Business-hours evidence was unavailable. Review the lead and published company configuration.'
          when disposition_value = 'missed_call_recovery'
            then 'A verified inbound call ended without connection. Review the lead before contacting them.'
          when disposition_value = 'after_hours'
            then 'A verified lead arrived outside the published business hours. Review it in Pipeline.'
          else 'A verified inbound message requires a person. Review it in Pipeline.'
        end,
        '/pipeline'
      );
    end loop;
  end if;

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
    new.company_id,
    now(),
    'provider',
    new.provider,
    'lead_intake_operational_disposition_recorded',
    'lead_intake_operational_disposition',
    disposition_id_value,
    null,
    jsonb_build_object(
      'disposition', disposition_value,
      'businessHoursStatus', business_hours_status_value,
      'missedCall', missed_call_value,
      'terminalCallStatus', terminal_call_status_value,
      'humanHandoffRequired', handoff_required_value,
      'handoffReasons', to_jsonb(handoff_reasons_value),
      'configurationId', case
        when business_hours_status_value = 'configuration_missing' then null
        else configuration_row.id
      end,
      'messageId', message_row.id
    ),
    new.id::text,
    'audit',
    now() + interval '7 years'
  );

  return new;
end;
$$;

create trigger webhook_events_lead_intake_operational_disposition
after update of payload on public.webhook_events
for each row
when (
  new.payload ? 'intakeReceipt'
  and old.payload -> 'intakeReceipt'
    is distinct from new.payload -> 'intakeReceipt'
)
execute function public.record_storyops_lead_intake_operational_disposition();

alter table public.lead_intake_operational_dispositions enable row level security;

create policy lead_intake_operational_dispositions_staff_select
on public.lead_intake_operational_dispositions
for select
using (
  public.has_company_role(
    company_id,
    array['owner', 'dispatcher']::public.app_role[]
  )
);

revoke all on table public.lead_intake_operational_dispositions
  from public, anon, authenticated, service_role;
grant select on table public.lead_intake_operational_dispositions
  to authenticated;

revoke all on function public.record_storyops_lead_intake_operational_disposition()
  from public, anon, authenticated, service_role;

create trigger storyops_active_company_mutation_gate
before insert or update or delete
on public.lead_intake_operational_dispositions
for each row
execute function public.assert_active_company_for_authenticated_mutation();

comment on table public.lead_intake_operational_dispositions is
  'Server-derived business-hours, missed-call, and finite human-handoff evidence for verified inbound lead intake.';
comment on function public.record_storyops_lead_intake_operational_disposition() is
  'Derives operational disposition from a persisted inbound message and immutable published company configuration; creates redacted owner actions without executing message instructions.';
