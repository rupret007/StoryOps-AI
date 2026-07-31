-- Authenticated customer requests and purpose-specific communication preferences.
-- A reschedule submission is deliberately a request record only: this migration
-- grants the customer no visit mutation path.

create table public.customer_portal_commands (
  id uuid primary key,
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  command_type text not null check (
    command_type in (
      'portal.reschedule.request',
      'portal.additional_service.request',
      'portal.communication_preferences.update'
    )
  ),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  canonical_request text not null check (
    length(canonical_request) between 2 and 12000
  ),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((result is null) = (completed_at is null))
);

create index customer_portal_commands_scope_idx
  on public.customer_portal_commands(company_id, customer_id, created_at desc);

create table public.customer_portal_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete restrict,
  submitted_by_user_id uuid not null references auth.users(id) on delete restrict,
  command_id uuid not null unique
    references public.customer_portal_commands(id) on delete restrict,
  request_type text not null check (
    request_type in ('reschedule', 'additional_service')
  ),
  status text not null default 'submitted' check (
    status in ('submitted', 'reviewing', 'resolved', 'cancelled')
  ),
  visit_id uuid references public.visits(id) on delete restrict,
  normalized_lead_id uuid references public.leads(id) on delete restrict,
  preferred_start_date date,
  preferred_end_date date,
  requested_service_codes text[] not null default '{}',
  request_notes text not null default '' check (length(request_notes) <= 2000),
  resolution_note text check (
    resolution_note is null or length(btrim(resolution_note)) between 1 and 2000
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  check (
    (
      request_type = 'reschedule'
      and visit_id is not null
      and normalized_lead_id is null
      and preferred_start_date is not null
      and preferred_end_date is not null
      and preferred_end_date >= preferred_start_date
      and cardinality(requested_service_codes) = 0
    )
    or (
      request_type = 'additional_service'
      and visit_id is null
      and normalized_lead_id is not null
      and preferred_start_date is null
      and preferred_end_date is null
      and cardinality(requested_service_codes) between 1 and 12
    )
  )
);

create index customer_portal_requests_customer_idx
  on public.customer_portal_requests(company_id, customer_id, created_at desc);
create index customer_portal_requests_staff_queue_idx
  on public.customer_portal_requests(company_id, status, created_at)
  where status in ('submitted', 'reviewing');

create table public.customer_communication_preferences (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  transactional_sms boolean not null default false,
  transactional_email boolean not null default false,
  marketing_sms boolean not null default false,
  marketing_email boolean not null default false,
  global_opt_out boolean not null default false,
  disclosure_version text not null check (
    disclosure_version ~ '^customer-portal-consent-v[0-9]+$'
  ),
  recorded_by_user_id uuid not null references auth.users(id) on delete restrict,
  source text not null default 'customer_portal'
    check (source = 'customer_portal'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (company_id, customer_id),
  check (
    not global_opt_out
    or (
      not transactional_sms
      and not transactional_email
      and not marketing_sms
      and not marketing_email
    )
  )
);

alter table public.customer_portal_commands enable row level security;
alter table public.customer_portal_commands force row level security;
alter table public.customer_portal_requests enable row level security;
alter table public.customer_portal_requests force row level security;
alter table public.customer_communication_preferences enable row level security;
alter table public.customer_communication_preferences force row level security;

revoke all on table public.customer_portal_commands
  from public, anon, authenticated, service_role;
revoke all on table public.customer_portal_requests
  from public, anon, authenticated, service_role;
revoke all on table public.customer_communication_preferences
  from public, anon, authenticated, service_role;

grant select on table public.customer_portal_requests to authenticated;
grant update on table public.customer_portal_requests to authenticated;
grant select on table public.customer_communication_preferences to authenticated;

create policy customer_portal_requests_customer_select
  on public.customer_portal_requests
  for select
  using (public.is_customer_user(company_id, customer_id));

create policy customer_portal_requests_staff_select
  on public.customer_portal_requests
  for select
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  );

create policy customer_portal_requests_staff_update
  on public.customer_portal_requests
  for update
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  )
  with check (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  );

create policy customer_communication_preferences_customer_select
  on public.customer_communication_preferences
  for select
  using (public.is_customer_user(company_id, customer_id));

create policy customer_communication_preferences_staff_select
  on public.customer_communication_preferences
  for select
  using (
    public.has_company_role(
      company_id,
      array['owner', 'dispatcher']::public.app_role[]
    )
  );

create or replace function public.validate_customer_portal_request()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
    and (
      to_jsonb(new) - array[
        'status', 'resolution_note', 'updated_at', 'version'
      ]
    ) <> (
      to_jsonb(old) - array[
        'status', 'resolution_note', 'updated_at', 'version'
      ]
    )
  then
    raise exception 'CUSTOMER_PORTAL_REQUEST_IMMUTABLE';
  end if;

  if not exists (
    select 1
    from public.customers customer
    where customer.id = new.customer_id
      and customer.company_id = new.company_id
  ) or not exists (
    select 1
    from public.properties property
    where property.id = new.property_id
      and property.company_id = new.company_id
      and property.customer_id = new.customer_id
  ) or not exists (
    select 1
    from public.customer_portal_commands command
    where command.id = new.command_id
      and command.company_id = new.company_id
      and command.customer_id = new.customer_id
      and command.actor_user_id = new.submitted_by_user_id
      and command.command_type = case new.request_type
        when 'reschedule' then 'portal.reschedule.request'
        else 'portal.additional_service.request'
      end
  )
  then
    raise exception 'CUSTOMER_PORTAL_REQUEST_SCOPE_MISMATCH';
  end if;

  if new.request_type = 'reschedule' and not exists (
    select 1
    from public.visits visit
    join public.jobs job on job.id = visit.job_id
    where visit.id = new.visit_id
      and visit.company_id = new.company_id
      and job.company_id = new.company_id
      and job.customer_id = new.customer_id
      and job.property_id = new.property_id
  ) then
    raise exception 'CUSTOMER_PORTAL_VISIT_SCOPE_MISMATCH';
  end if;

  if new.request_type = 'additional_service' and not exists (
    select 1
    from public.leads lead
    where lead.id = new.normalized_lead_id
      and lead.company_id = new.company_id
      and lead.customer_id = new.customer_id
      and lead.property_id = new.property_id
      and lead.requested_services @> new.requested_service_codes
  ) then
    raise exception 'CUSTOMER_PORTAL_LEAD_SCOPE_MISMATCH';
  end if;

  return new;
end;
$$;

create trigger customer_portal_requests_validate
  before insert or update on public.customer_portal_requests
  for each row execute function public.validate_customer_portal_request();
create trigger customer_portal_requests_touch
  before update on public.customer_portal_requests
  for each row execute function public.touch_record();
create trigger customer_communication_preferences_touch
  before update on public.customer_communication_preferences
  for each row execute function public.touch_record();

create or replace function public.audit_customer_portal_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  source jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  company_id_value uuid := (source ->> 'company_id')::uuid;
  entity_id_value uuid := (source ->> 'id')::uuid;
  actor_id_value text := coalesce(auth.uid()::text, 'system');
  actor_type_value text := case
    when auth.uid() is not null
      and public.has_company_role(
        company_id_value,
        array['customer']::public.app_role[]
      )
    then 'customer'
    when auth.uid() is not null then 'user'
    else 'system'
  end;
  safe_before jsonb;
  safe_after jsonb;
begin
  if tg_table_name = 'customer_portal_requests' then
    safe_before := case when tg_op in ('UPDATE', 'DELETE') then jsonb_build_object(
      'requestType', old.request_type,
      'status', old.status,
      'customerId', old.customer_id,
      'propertyId', old.property_id,
      'visitId', old.visit_id,
      'normalizedLeadId', old.normalized_lead_id,
      'version', old.version
    ) else null end;
    safe_after := case when tg_op in ('INSERT', 'UPDATE') then jsonb_build_object(
      'requestType', new.request_type,
      'status', new.status,
      'customerId', new.customer_id,
      'propertyId', new.property_id,
      'visitId', new.visit_id,
      'normalizedLeadId', new.normalized_lead_id,
      'version', new.version
    ) else null end;
  else
    safe_before := case when tg_op = 'UPDATE' then jsonb_build_object(
      'customerId', old.customer_id,
      'transactionalSms', old.transactional_sms,
      'transactionalEmail', old.transactional_email,
      'marketingSms', old.marketing_sms,
      'marketingEmail', old.marketing_email,
      'globalOptOut', old.global_opt_out,
      'disclosureVersion', old.disclosure_version,
      'version', old.version
    ) else null end;
    safe_after := case when tg_op in ('INSERT', 'UPDATE') then jsonb_build_object(
      'customerId', new.customer_id,
      'transactionalSms', new.transactional_sms,
      'transactionalEmail', new.transactional_email,
      'marketingSms', new.marketing_sms,
      'marketingEmail', new.marketing_email,
      'globalOptOut', new.global_opt_out,
      'disclosureVersion', new.disclosure_version,
      'version', new.version
    ) else null end;
  end if;

  insert into public.audit_events(
    company_id,
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
    company_id_value,
    actor_type_value,
    actor_id_value,
    lower(tg_op),
    tg_table_name,
    entity_id_value,
    safe_before,
    safe_after,
    coalesce(
      nullif(current_setting('request.headers', true), ''),
      '{}'::text
    )::jsonb ->> 'x-request-id',
    'audit',
    now() + interval '7 years'
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger customer_portal_requests_audit
  after insert or update or delete on public.customer_portal_requests
  for each row execute function public.audit_customer_portal_mutation();
create trigger customer_communication_preferences_audit
  after insert or update on public.customer_communication_preferences
  for each row execute function public.audit_customer_portal_mutation();

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
    raise exception 'CUSTOMER_PORTAL_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    join public.customer_portal_users portal
      on portal.company_id = membership.company_id
      and portal.user_id = membership.user_id
      and portal.customer_id = p_customer_id
    where membership.company_id = p_company_id
      and membership.user_id = actor_user_id
      and membership.role = 'customer'
      and membership.active
  ) then
    raise exception 'CUSTOMER_PORTAL_SCOPE_DENIED';
  end if;
  return actor_user_id;
end;
$$;

revoke all on function public.storyops_assert_customer_portal_subject(uuid, uuid)
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
  result_value jsonb;
begin
  if actor_user_id is null then
    raise exception 'CUSTOMER_PORTAL_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    where membership.company_id = p_company_id
      and membership.user_id = actor_user_id
      and membership.role = 'customer'
      and membership.active
  ) then
    raise exception 'CUSTOMER_PORTAL_SCOPE_DENIED';
  end if;

  select jsonb_build_object(
    'schemaVersion', 'storyops-customer-portal-state-v1',
    'companyId', p_company_id,
    'serverTime', now(),
    'customers', coalesce(jsonb_agg(
      jsonb_build_object(
        'customerId', customer.id,
        'requests', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', request.id,
            'customerId', request.customer_id,
            'propertyId', request.property_id,
            'requestType', request.request_type,
            'status', request.status,
            'visitId', request.visit_id,
            'normalizedLeadId', request.normalized_lead_id,
            'preferredStartDate', request.preferred_start_date,
            'preferredEndDate', request.preferred_end_date,
            'requestedServiceCodes', request.requested_service_codes,
            'requestNotes', request.request_notes,
            'resolutionNote', request.resolution_note,
            'createdAt', request.created_at,
            'updatedAt', request.updated_at,
            'version', request.version
          ) order by request.created_at desc)
          from public.customer_portal_requests request
          where request.company_id = p_company_id
            and request.customer_id = customer.id
        ), '[]'::jsonb),
        'preferences', jsonb_build_object(
          'customerId', customer.id,
          'transactionalSms', case when customer.do_not_contact or coalesce(preference.global_opt_out, false) then false else coalesce((
            select consent.status = 'granted'
            from public.consent_records consent
            where consent.company_id = p_company_id
              and consent.customer_id = customer.id
              and consent.channel = 'sms'
              and consent.purpose = 'transactional'
            order by consent.captured_at desc, consent.created_at desc, consent.id desc
            limit 1
          ), false) end,
          'transactionalEmail', case when customer.do_not_contact or coalesce(preference.global_opt_out, false) then false else coalesce((
            select consent.status = 'granted'
            from public.consent_records consent
            where consent.company_id = p_company_id
              and consent.customer_id = customer.id
              and consent.channel = 'email'
              and consent.purpose = 'transactional'
            order by consent.captured_at desc, consent.created_at desc, consent.id desc
            limit 1
          ), false) end,
          'marketingSms', case when customer.do_not_contact or coalesce(preference.global_opt_out, false) then false else coalesce((
            select consent.status = 'granted'
            from public.consent_records consent
            where consent.company_id = p_company_id
              and consent.customer_id = customer.id
              and consent.channel = 'sms'
              and consent.purpose = 'marketing'
            order by consent.captured_at desc, consent.created_at desc, consent.id desc
            limit 1
          ), false) end,
          'marketingEmail', case when customer.do_not_contact or coalesce(preference.global_opt_out, false) then false else coalesce((
            select consent.status = 'granted'
            from public.consent_records consent
            where consent.company_id = p_company_id
              and consent.customer_id = customer.id
              and consent.channel = 'email'
              and consent.purpose = 'marketing'
            order by consent.captured_at desc, consent.created_at desc, consent.id desc
            limit 1
          ), false) end,
          'globalOptOut', customer.do_not_contact or coalesce(preference.global_opt_out, false),
          'disclosureVersion', coalesce(preference.disclosure_version, 'customer-portal-consent-v1'),
          'updatedAt', preference.updated_at,
          'version', coalesce(preference.version, 0)
        ),
        'serviceOptions', coalesce((
          select jsonb_agg(jsonb_build_object(
            'code', service.code,
            'name', service.name
          ) order by service.name)
          from public.service_catalog service
          where service.company_id = p_company_id
            and service.active
        ), '[]'::jsonb)
      )
      order by customer.display_name, customer.id
    ), '[]'::jsonb)
  )
  into result_value
  from public.customer_portal_users portal
  join public.customers customer
    on customer.id = portal.customer_id
    and customer.company_id = portal.company_id
  left join public.customer_communication_preferences preference
    on preference.company_id = customer.company_id
    and preference.customer_id = customer.id
  where portal.company_id = p_company_id
    and portal.user_id = actor_user_id;

  return result_value;
end;
$$;

revoke all on function public.get_customer_portal_state(uuid)
  from public, anon;
grant execute on function public.get_customer_portal_state(uuid)
  to authenticated;

create or replace function public.submit_customer_portal_request(
  p_company_id uuid,
  p_customer_id uuid,
  p_command_id uuid,
  p_command_type text,
  p_canonical_request text,
  p_request_hash text,
  p_request_type text,
  p_visit_id uuid,
  p_property_id uuid,
  p_preferred_start_date date,
  p_preferred_end_date date,
  p_requested_service_codes text[],
  p_request_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid;
  customer_row public.customers%rowtype;
  command_row public.customer_portal_commands%rowtype;
  expected_payload jsonb;
  expected_request jsonb;
  calculated_hash text;
  normalized_services text[] := coalesce(p_requested_service_codes, array[]::text[]);
  request_id_value uuid := gen_random_uuid();
  lead_id_value uuid;
  receipt_value jsonb;
begin
  actor_user_id := public.storyops_assert_customer_portal_subject(
    p_company_id,
    p_customer_id
  );
  if p_command_id is null
    or p_request_type not in ('reschedule', 'additional_service')
    or p_command_type is distinct from (case p_request_type
      when 'reschedule' then 'portal.reschedule.request'
      else 'portal.additional_service.request'
    end)
    or p_property_id is null
    or p_request_notes is null
    or length(p_request_notes) > 2000
    or p_request_notes ~ '[[:cntrl:]]'
  then
    raise exception 'CUSTOMER_PORTAL_INVALID_REQUEST';
  end if;

  expected_payload := jsonb_build_object(
    'customerId', p_customer_id,
    'preferredEndDate', p_preferred_end_date,
    'preferredStartDate', p_preferred_start_date,
    'propertyId', p_property_id,
    'requestNotes', btrim(p_request_notes),
    'requestType', p_request_type,
    'requestedServiceCodes', to_jsonb(normalized_services),
    'visitId', p_visit_id
  );
  expected_request := jsonb_build_object(
    'commandType', p_command_type,
    'payload', expected_payload
  );
  calculated_hash := encode(
    extensions.digest(convert_to(p_canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  begin
    if p_request_hash is distinct from calculated_hash
      or p_request_hash !~ '^[a-f0-9]{64}$'
      or p_canonical_request::jsonb <> expected_request
    then
      raise exception 'CUSTOMER_PORTAL_REQUEST_HASH_MISMATCH';
    end if;
  exception
    when invalid_text_representation then
      raise exception 'CUSTOMER_PORTAL_REQUEST_HASH_MISMATCH';
  end;

  insert into public.customer_portal_commands(
    id,
    company_id,
    customer_id,
    actor_user_id,
    command_type,
    request_hash,
    canonical_request
  )
  values (
    p_command_id,
    p_company_id,
    p_customer_id,
    actor_user_id,
    p_command_type,
    p_request_hash,
    p_canonical_request
  )
  on conflict (id) do nothing;

  select *
  into command_row
  from public.customer_portal_commands command
  where command.id = p_command_id
  for update;

  if command_row.company_id is distinct from p_company_id
    or command_row.customer_id is distinct from p_customer_id
    or command_row.actor_user_id is distinct from actor_user_id
    or command_row.command_type is distinct from p_command_type
    or command_row.request_hash is distinct from p_request_hash
    or command_row.canonical_request::jsonb <> expected_request
  then
    raise exception 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT';
  end if;
  if command_row.result is not null then
    return jsonb_set(command_row.result, '{replayed}', 'true'::jsonb);
  end if;

  select *
  into customer_row
  from public.customers customer
  where customer.id = p_customer_id
    and customer.company_id = p_company_id
  for share;
  if not found or not exists (
    select 1
    from public.properties property
    where property.id = p_property_id
      and property.company_id = p_company_id
      and property.customer_id = p_customer_id
  ) then
    raise exception 'CUSTOMER_PORTAL_PROPERTY_SCOPE_MISMATCH';
  end if;

  if p_request_type = 'reschedule' then
    if p_visit_id is null
      or p_preferred_start_date is null
      or p_preferred_end_date is null
      or p_preferred_end_date < p_preferred_start_date
      or p_preferred_start_date < current_date
      or p_preferred_end_date > current_date + 365
      or cardinality(normalized_services) <> 0
      or not exists (
        select 1
        from public.visits visit
        join public.jobs job on job.id = visit.job_id
        where visit.id = p_visit_id
          and visit.company_id = p_company_id
          and visit.status not in ('completed', 'cancelled')
          and job.company_id = p_company_id
          and job.customer_id = p_customer_id
          and job.property_id = p_property_id
      )
    then
      raise exception 'CUSTOMER_PORTAL_INVALID_RESCHEDULE_REQUEST';
    end if;
  else
    if p_visit_id is not null
      or p_preferred_start_date is not null
      or p_preferred_end_date is not null
      or cardinality(normalized_services) not between 1 and 12
      or cardinality(normalized_services) <> (
        select count(distinct service_code)
        from unnest(normalized_services) service(service_code)
      )
      or exists (
        select 1
        from unnest(normalized_services) service(service_code)
        where service_code !~ '^[a-z0-9][a-z0-9_-]{0,79}$'
          or not exists (
            select 1
            from public.service_catalog catalog
            where catalog.company_id = p_company_id
              and catalog.code = service_code
              and catalog.active
          )
      )
    then
      raise exception 'CUSTOMER_PORTAL_INVALID_ADDITIONAL_SERVICE_REQUEST';
    end if;

    lead_id_value := gen_random_uuid();
    insert into public.leads(
      id,
      company_id,
      source,
      status,
      display_name,
      requested_services,
      qualification_summary,
      customer_id,
      property_id
    )
    values (
      lead_id_value,
      p_company_id,
      'web',
      'new',
      customer_row.display_name,
      normalized_services,
      'Authenticated customer-portal request; measurements, scope, availability, and price remain unverified.',
      p_customer_id,
      p_property_id
    );
  end if;

  insert into public.customer_portal_requests(
    id,
    company_id,
    customer_id,
    property_id,
    submitted_by_user_id,
    command_id,
    request_type,
    visit_id,
    normalized_lead_id,
    preferred_start_date,
    preferred_end_date,
    requested_service_codes,
    request_notes
  )
  values (
    request_id_value,
    p_company_id,
    p_customer_id,
    p_property_id,
    actor_user_id,
    p_command_id,
    p_request_type,
    p_visit_id,
    lead_id_value,
    p_preferred_start_date,
    p_preferred_end_date,
    normalized_services,
    btrim(p_request_notes)
  );

  receipt_value := jsonb_build_object(
    'schemaVersion', 'storyops-customer-portal-request-v1',
    'companyId', p_company_id,
    'customerId', p_customer_id,
    'commandId', p_command_id,
    'requestHash', p_request_hash,
    'requestId', request_id_value,
    'requestType', p_request_type,
    'status', 'submitted',
    'normalizedLeadId', lead_id_value,
    'visitChanged', false,
    'replayed', false,
    'serverTime', now()
  );

  update public.customer_portal_commands
  set result = receipt_value, completed_at = now()
  where id = p_command_id;
  return receipt_value;
end;
$$;

revoke all on function public.submit_customer_portal_request(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  date,
  date,
  text[],
  text
) from public, anon;
grant execute on function public.submit_customer_portal_request(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  date,
  date,
  text[],
  text
) to authenticated;

create or replace function public.update_customer_communication_preferences(
  p_company_id uuid,
  p_customer_id uuid,
  p_command_id uuid,
  p_canonical_request text,
  p_request_hash text,
  p_transactional_sms boolean,
  p_transactional_email boolean,
  p_marketing_sms boolean,
  p_marketing_email boolean,
  p_global_opt_out boolean,
  p_disclosure_version text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid;
  customer_row public.customers%rowtype;
  command_row public.customer_portal_commands%rowtype;
  expected_payload jsonb;
  expected_request jsonb;
  calculated_hash text;
  command_type_value constant text := 'portal.communication_preferences.update';
  consent_ids uuid[] := array[
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid(),
    gen_random_uuid()
  ];
  sms_fingerprint text;
  email_fingerprint text;
  preferences_version_value integer;
  receipt_value jsonb;
begin
  actor_user_id := public.storyops_assert_customer_portal_subject(
    p_company_id,
    p_customer_id
  );
  if p_command_id is null
    or p_transactional_sms is null
    or p_transactional_email is null
    or p_marketing_sms is null
    or p_marketing_email is null
    or p_global_opt_out is null
    or p_disclosure_version !~ '^customer-portal-consent-v[0-9]+$'
    or (
      p_global_opt_out
      and (
        p_transactional_sms
        or p_transactional_email
        or p_marketing_sms
        or p_marketing_email
      )
    )
  then
    raise exception 'CUSTOMER_PORTAL_INVALID_COMMUNICATION_PREFERENCES';
  end if;

  expected_payload := jsonb_build_object(
    'customerId', p_customer_id,
    'disclosureVersion', p_disclosure_version,
    'globalOptOut', p_global_opt_out,
    'marketingEmail', p_marketing_email,
    'marketingSms', p_marketing_sms,
    'transactionalEmail', p_transactional_email,
    'transactionalSms', p_transactional_sms
  );
  expected_request := jsonb_build_object(
    'commandType', command_type_value,
    'payload', expected_payload
  );
  calculated_hash := encode(
    extensions.digest(convert_to(p_canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  begin
    if p_request_hash is distinct from calculated_hash
      or p_request_hash !~ '^[a-f0-9]{64}$'
      or p_canonical_request::jsonb <> expected_request
    then
      raise exception 'CUSTOMER_PORTAL_REQUEST_HASH_MISMATCH';
    end if;
  exception
    when invalid_text_representation then
      raise exception 'CUSTOMER_PORTAL_REQUEST_HASH_MISMATCH';
  end;

  insert into public.customer_portal_commands(
    id,
    company_id,
    customer_id,
    actor_user_id,
    command_type,
    request_hash,
    canonical_request
  )
  values (
    p_command_id,
    p_company_id,
    p_customer_id,
    actor_user_id,
    command_type_value,
    p_request_hash,
    p_canonical_request
  )
  on conflict (id) do nothing;

  select *
  into command_row
  from public.customer_portal_commands command
  where command.id = p_command_id
  for update;

  if command_row.company_id is distinct from p_company_id
    or command_row.customer_id is distinct from p_customer_id
    or command_row.actor_user_id is distinct from actor_user_id
    or command_row.command_type is distinct from command_type_value
    or command_row.request_hash is distinct from p_request_hash
    or command_row.canonical_request::jsonb <> expected_request
  then
    raise exception 'CUSTOMER_PORTAL_IDEMPOTENCY_CONFLICT';
  end if;
  if command_row.result is not null then
    return jsonb_set(command_row.result, '{replayed}', 'true'::jsonb);
  end if;

  select *
  into customer_row
  from public.customers customer
  where customer.id = p_customer_id
    and customer.company_id = p_company_id
  for update;
  if not found then
    raise exception 'CUSTOMER_PORTAL_CUSTOMER_SCOPE_MISMATCH';
  end if;
  if (p_transactional_sms or p_marketing_sms)
    and public.storyops_normalize_phone(customer_row.phone) is null
  then
    raise exception 'CUSTOMER_PORTAL_SMS_CONTACT_REQUIRED';
  end if;
  if (p_transactional_email or p_marketing_email)
    and nullif(lower(btrim(customer_row.email::text)), '') is null
  then
    raise exception 'CUSTOMER_PORTAL_EMAIL_CONTACT_REQUIRED';
  end if;

  insert into public.customer_communication_preferences(
    company_id,
    customer_id,
    transactional_sms,
    transactional_email,
    marketing_sms,
    marketing_email,
    global_opt_out,
    disclosure_version,
    recorded_by_user_id
  )
  values (
    p_company_id,
    p_customer_id,
    p_transactional_sms,
    p_transactional_email,
    p_marketing_sms,
    p_marketing_email,
    p_global_opt_out,
    p_disclosure_version,
    actor_user_id
  )
  on conflict (company_id, customer_id) do update
  set
    transactional_sms = excluded.transactional_sms,
    transactional_email = excluded.transactional_email,
    marketing_sms = excluded.marketing_sms,
    marketing_email = excluded.marketing_email,
    global_opt_out = excluded.global_opt_out,
    disclosure_version = excluded.disclosure_version,
    recorded_by_user_id = excluded.recorded_by_user_id;

  insert into public.consent_records(
    id,
    company_id,
    customer_id,
    channel,
    purpose,
    status,
    captured_at,
    capture_method,
    disclosure_version,
    proof,
    withdrawn_at
  )
  values
    (
      consent_ids[1],
      p_company_id,
      p_customer_id,
      'sms',
      'transactional',
      case when p_transactional_sms then 'granted' else 'withdrawn' end,
      now(),
      'web_form',
      p_disclosure_version,
      'authenticated_customer_portal;command=' || p_command_id::text,
      case when p_transactional_sms then null else now() end
    ),
    (
      consent_ids[2],
      p_company_id,
      p_customer_id,
      'email',
      'transactional',
      case when p_transactional_email then 'granted' else 'withdrawn' end,
      now(),
      'web_form',
      p_disclosure_version,
      'authenticated_customer_portal;command=' || p_command_id::text,
      case when p_transactional_email then null else now() end
    ),
    (
      consent_ids[3],
      p_company_id,
      p_customer_id,
      'sms',
      'marketing',
      case when p_marketing_sms then 'granted' else 'withdrawn' end,
      now(),
      'web_form',
      p_disclosure_version,
      'authenticated_customer_portal;command=' || p_command_id::text,
      case when p_marketing_sms then null else now() end
    ),
    (
      consent_ids[4],
      p_company_id,
      p_customer_id,
      'email',
      'marketing',
      case when p_marketing_email then 'granted' else 'withdrawn' end,
      now(),
      'web_form',
      p_disclosure_version,
      'authenticated_customer_portal;command=' || p_command_id::text,
      case when p_marketing_email then null else now() end
    );

  if public.storyops_normalize_phone(customer_row.phone) is not null then
    sms_fingerprint := encode(
      extensions.digest(
        public.storyops_normalize_phone(customer_row.phone),
        'sha256'
      ),
      'hex'
    );
    if not p_transactional_sms and not p_marketing_sms then
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
        sms_fingerprint,
        'active',
        'authenticated customer portal preference',
        'customer_portal',
        p_command_id::text,
        now(),
        now()
      )
      on conflict (company_id, channel, contact_fingerprint) do update
      set
        status = 'active',
        reason = excluded.reason,
        source_provider = excluded.source_provider,
        source_event_id = excluded.source_event_id,
        last_observed_at = excluded.last_observed_at,
        released_at = null,
        release_reason = null,
        updated_at = now(),
        version = public.contact_suppressions.version + 1;
    else
      update public.contact_suppressions
      set
        status = 'released',
        released_at = now(),
        release_reason = 'authenticated customer portal explicit consent',
        updated_at = now(),
        version = version + 1
      where company_id = p_company_id
        and channel = 'sms'
        and contact_fingerprint = sms_fingerprint
        and status = 'active';
    end if;
  end if;

  if nullif(lower(btrim(customer_row.email::text)), '') is not null then
    email_fingerprint := encode(
      extensions.digest(lower(btrim(customer_row.email::text)), 'sha256'),
      'hex'
    );
    if not p_transactional_email and not p_marketing_email then
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
        'email',
        email_fingerprint,
        'active',
        'authenticated customer portal preference',
        'customer_portal',
        p_command_id::text,
        now(),
        now()
      )
      on conflict (company_id, channel, contact_fingerprint) do update
      set
        status = 'active',
        reason = excluded.reason,
        source_provider = excluded.source_provider,
        source_event_id = excluded.source_event_id,
        last_observed_at = excluded.last_observed_at,
        released_at = null,
        release_reason = null,
        updated_at = now(),
        version = public.contact_suppressions.version + 1;
    else
      update public.contact_suppressions
      set
        status = 'released',
        released_at = now(),
        release_reason = 'authenticated customer portal explicit consent',
        updated_at = now(),
        version = version + 1
      where company_id = p_company_id
        and channel = 'email'
        and contact_fingerprint = email_fingerprint
        and status = 'active';
    end if;
  end if;

  select preference.version
  into preferences_version_value
  from public.customer_communication_preferences preference
  where preference.company_id = p_company_id
    and preference.customer_id = p_customer_id;

  receipt_value := jsonb_build_object(
    'schemaVersion', 'storyops-customer-communication-preferences-v1',
    'companyId', p_company_id,
    'customerId', p_customer_id,
    'commandId', p_command_id,
    'requestHash', p_request_hash,
    'preferencesVersion', preferences_version_value,
    'consentRecordIds', to_jsonb(consent_ids),
    'globalOptOut', p_global_opt_out,
    'replayed', false,
    'serverTime', now()
  );
  update public.customer_portal_commands
  set result = receipt_value, completed_at = now()
  where id = p_command_id;
  return receipt_value;
end;
$$;

revoke all on function public.update_customer_communication_preferences(
  uuid,
  uuid,
  uuid,
  text,
  text,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  text
) from public, anon;
grant execute on function public.update_customer_communication_preferences(
  uuid,
  uuid,
  uuid,
  text,
  text,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
  text
) to authenticated;

comment on table public.customer_portal_requests is
  'Customer-authored requests. Reschedule rows are review work items and never mutate visits.';
comment on table public.customer_communication_preferences is
  'Authenticated preference snapshot; purpose-specific consent_records remain the outbound authority.';
comment on function public.submit_customer_portal_request(
  uuid,
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  date,
  date,
  text[],
  text
) is
  'Idempotently stores an isolated reschedule request or creates a linked existing-domain lead for an additional-service request.';
