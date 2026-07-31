-- Immutable setup receipt authority.
--
-- Setup is an idempotent command, so an exact replay must return the facts
-- committed by the original command. Company lifecycle and provider state are
-- intentionally mutable after setup and therefore cannot be used to rebuild
-- that receipt. Keep the receipt in a private append-only relation, and admit
-- legacy evidence only when one exact append-only setup audit event proves the
-- command and its original completion timestamp.

create table private.storyops_setup_receipts (
  company_id uuid primary key
    references public.companies(id) on delete restrict,
  command_id uuid not null,
  request_hash text not null
    check (request_hash ~ '^[a-f0-9]{64}$'),
  setup_input jsonb not null
    check (jsonb_typeof(setup_input) = 'object'),
  company_status text not null
    check (company_status = 'setup'),
  service_count smallint not null
    check (service_count between 1 and 5),
  available_service_count smallint not null
    check (available_service_count = 5),
  integrations_disabled smallint not null
    check (integrations_disabled = 11),
  setup_completed_at timestamptz not null,
  evidence_audit_event_id uuid not null unique
    references public.audit_events(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  unique (company_id, command_id),
  check (
    jsonb_typeof(setup_input -> 'enabledServiceCodes') = 'array'
    and jsonb_array_length(setup_input -> 'enabledServiceCodes')
      = service_count
  )
);

create table private.storyops_setup_receipt_quarantines (
  company_id uuid primary key
    references public.companies(id) on delete restrict,
  reason text not null check (reason in (
    'missing_command_metadata',
    'invalid_setup_input',
    'missing_setup_audit',
    'missing_exact_setup_audit',
    'ambiguous_setup_audit',
    'setup_completed_at_invalid',
    'setup_completed_at_mismatch'
  )),
  observed_command_id text,
  setup_audit_count integer not null check (setup_audit_count >= 0),
  exact_audit_count integer not null check (exact_audit_count >= 0),
  detected_at timestamptz not null default now()
);

revoke all on table private.storyops_setup_receipts
  from public, anon, authenticated, service_role;
revoke all on table private.storyops_setup_receipt_quarantines
  from public, anon, authenticated, service_role;

create or replace function
  private.reject_storyops_setup_receipt_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, private
as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

revoke all on function
  private.reject_storyops_setup_receipt_mutation()
  from public, anon, authenticated, service_role;

create trigger storyops_setup_receipts_append_only
before update or delete on private.storyops_setup_receipts
for each row execute function
  private.reject_storyops_setup_receipt_mutation();

create trigger storyops_setup_receipt_quarantines_append_only
before update or delete on private.storyops_setup_receipt_quarantines
for each row execute function
  private.reject_storyops_setup_receipt_mutation();

-- This routine is retained for reviewed restore/import remediation. It never
-- guesses a completion time and never accepts mutable company/provider state as
-- setup receipt evidence. A completed company without one exact matching audit
-- is recorded in the private quarantine ledger and remains unreplayable.
create or replace function
  private.backfill_storyops_setup_receipts_v1_2()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  company_record public.companies%rowtype;
  exact_audit_record public.audit_events%rowtype;
  command_id_text text;
  request_hash_value text;
  setup_input_value jsonb;
  enabled_service_codes jsonb;
  setup_audit_count_value integer;
  exact_audit_count_value integer;
  service_count_value integer;
  existing_completed_at timestamptz;
  quarantine_reason text;
  inserted_count integer := 0;
  quarantined_count integer := 0;
begin
  for company_record in
    select company.*
    from public.companies company
    where company.settings -> 'setupWizardCompleted' = 'true'::jsonb
      and not exists (
        select 1
        from private.storyops_setup_receipts receipt
        where receipt.company_id = company.id
      )
    order by company.id
    for update
  loop
    command_id_text := company_record.settings ->> 'setupCommandId';
    request_hash_value := company_record.settings ->> 'setupRequestHash';
    setup_input_value := company_record.settings -> 'setupInput';
    enabled_service_codes := setup_input_value -> 'enabledServiceCodes';
    setup_audit_count_value := 0;
    exact_audit_count_value := 0;
    exact_audit_record := null;
    existing_completed_at := null;
    quarantine_reason := null;

    if command_id_text is null
      or command_id_text !~* (
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-'
        || '[0-9a-f]{4}-[0-9a-f]{12}$'
      )
      or request_hash_value is null
      or request_hash_value !~ '^[a-f0-9]{64}$'
    then
      quarantine_reason := 'missing_command_metadata';
    elsif jsonb_typeof(setup_input_value) is distinct from 'object'
      or jsonb_typeof(enabled_service_codes) is distinct from 'array'
    then
      quarantine_reason := 'invalid_setup_input';
    elsif jsonb_array_length(enabled_service_codes) not between 1 and 5
      or length(btrim(coalesce(
        setup_input_value ->> 'businessName',
        ''
      ))) not between 2 and 80
      or length(btrim(coalesce(
        setup_input_value ->> 'ownerName',
        ''
      ))) not between 2 and 80
      or setup_input_value ->> 'businessName' ~ '[[:cntrl:]]'
      or setup_input_value ->> 'ownerName' ~ '[[:cntrl:]]'
      or coalesce(setup_input_value ->> 'homePostalCode', '')
        !~ '^[0-9]{5}$'
      or setup_input_value ->> 'timezone' <> 'America/Chicago'
      or setup_input_value -> 'policyAcknowledged'
        is distinct from 'true'::jsonb
      or setup_input_value <> jsonb_build_object(
        'businessName', btrim(setup_input_value ->> 'businessName'),
        'ownerName', btrim(setup_input_value ->> 'ownerName'),
        'homePostalCode', setup_input_value ->> 'homePostalCode',
        'timezone', setup_input_value ->> 'timezone',
        'enabledServiceCodes', enabled_service_codes,
        'policyAcknowledged', true
      )
      or (
        select count(*) <> count(distinct code)
        from jsonb_array_elements_text(enabled_service_codes) code
      )
      or exists (
        select 1
        from jsonb_array_elements_text(enabled_service_codes) code
        where code not in (
          'pressure-wash-flatwork',
          'soft-wash-house',
          'gutter-cleaning',
          'roof-washing',
          'window-cleaning'
        )
      )
    then
      quarantine_reason := 'invalid_setup_input';
    else
      select count(*)::integer
      into setup_audit_count_value
      from public.audit_events event
      where event.company_id = company_record.id
        and event.action = 'company.setup_completed'
        and event.entity_type = 'company'
        and event.entity_id = company_record.id;

      select count(*)::integer
      into exact_audit_count_value
      from public.audit_events event
      where event.company_id = company_record.id
        and event.action = 'company.setup_completed'
        and event.entity_type = 'company'
        and event.entity_id = company_record.id
        and event.actor_type = 'user'
        and event.request_id = command_id_text
        and event.after_data -> 'serviceCodes'
          = setup_input_value -> 'enabledServiceCodes'
        and event.after_data -> 'companyStatus' = '"setup"'::jsonb
        and event.after_data -> 'providers' = '"disabled"'::jsonb
        and event.after_data -> 'priceBook' = '"draft"'::jsonb
        and event.after_data -> 'terms' = '"draft"'::jsonb
        and event.after_data -> 'retentionPolicy' = '"draft"'::jsonb
        and event.after_data -> 'launchAuthorized' = 'false'::jsonb;

      if setup_audit_count_value = 0 then
        quarantine_reason := 'missing_setup_audit';
      elsif setup_audit_count_value <> 1 then
        quarantine_reason := 'ambiguous_setup_audit';
      elsif exact_audit_count_value <> 1 then
        quarantine_reason := 'missing_exact_setup_audit';
      else
        select event.*
        into strict exact_audit_record
        from public.audit_events event
        where event.company_id = company_record.id
          and event.action = 'company.setup_completed'
          and event.entity_type = 'company'
          and event.entity_id = company_record.id
          and event.actor_type = 'user'
          and event.request_id = command_id_text
          and event.after_data -> 'serviceCodes'
            = setup_input_value -> 'enabledServiceCodes'
          and event.after_data -> 'companyStatus' = '"setup"'::jsonb
          and event.after_data -> 'providers' = '"disabled"'::jsonb
          and event.after_data -> 'priceBook' = '"draft"'::jsonb
          and event.after_data -> 'terms' = '"draft"'::jsonb
          and event.after_data -> 'retentionPolicy' = '"draft"'::jsonb
          and event.after_data -> 'launchAuthorized' = 'false'::jsonb;

        if nullif(
          company_record.settings ->> 'setupCompletedAt',
          ''
        ) is not null then
          begin
            existing_completed_at :=
              (company_record.settings ->> 'setupCompletedAt')::timestamptz;
          exception
            when others then
              quarantine_reason := 'setup_completed_at_invalid';
          end;

          if quarantine_reason is null
            and existing_completed_at is distinct from
              exact_audit_record.occurred_at
          then
            quarantine_reason := 'setup_completed_at_mismatch';
          end if;
        end if;
      end if;
    end if;

    if quarantine_reason is not null then
      insert into private.storyops_setup_receipt_quarantines(
        company_id,
        reason,
        observed_command_id,
        setup_audit_count,
        exact_audit_count
      )
      values (
        company_record.id,
        quarantine_reason,
        command_id_text,
        setup_audit_count_value,
        exact_audit_count_value
      )
      on conflict (company_id) do nothing;
      if found then
        quarantined_count := quarantined_count + 1;
      end if;
      continue;
    end if;

    if nullif(
      company_record.settings ->> 'setupCompletedAt',
      ''
    ) is null then
      update public.companies company
      set settings = jsonb_set(
        company.settings,
        '{setupCompletedAt}',
        to_jsonb(exact_audit_record.occurred_at),
        true
      )
      where company.id = company_record.id;
    end if;

    service_count_value := jsonb_array_length(enabled_service_codes);
    insert into private.storyops_setup_receipts(
      company_id,
      command_id,
      request_hash,
      setup_input,
      company_status,
      service_count,
      available_service_count,
      integrations_disabled,
      setup_completed_at,
      evidence_audit_event_id
    )
    values (
      company_record.id,
      command_id_text::uuid,
      request_hash_value,
      setup_input_value,
      'setup',
      service_count_value,
      5,
      11,
      exact_audit_record.occurred_at,
      exact_audit_record.id
    )
    on conflict (company_id) do nothing;
    if found then
      inserted_count := inserted_count + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', inserted_count,
    'quarantined', quarantined_count
  );
end;
$$;

revoke all on function
  private.backfill_storyops_setup_receipts_v1_2()
  from public, anon, authenticated, service_role;

-- The forward guard from migration 54 already protects setupCompletedAt.
-- Remove it only inside this migration transaction, admit exact legacy audit
-- timestamps, then install it again before the transaction can commit.
drop trigger if exists companies_guard_system_state on public.companies;

select private.backfill_storyops_setup_receipts_v1_2();

-- Retain the migration-51 provider adapter as a private implementation. The
-- public signature below remains the sole API and keeps its original ACL.
alter function public.complete_storyops_setup(
  uuid, uuid, text, text, text, text, text, text[], boolean
) rename to complete_storyops_setup_v1_1_adapter;

alter function public.complete_storyops_setup_v1_1_adapter(
  uuid, uuid, text, text, text, text, text, text[], boolean
) set schema private;

revoke all on function private.complete_storyops_setup_v1_1_adapter(
  uuid, uuid, text, text, text, text, text, text[], boolean
) from public, anon, authenticated, service_role;

create or replace function public.complete_storyops_setup(
  p_company_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_business_name text,
  p_owner_name text,
  p_home_postal_code text,
  p_timezone text,
  p_enabled_service_codes text[],
  p_policy_acknowledged boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_membership public.company_memberships%rowtype;
  company_record public.companies%rowtype;
  receipt_record private.storyops_setup_receipts%rowtype;
  exact_audit_record public.audit_events%rowtype;
  current_setup_input jsonb;
  adapter_result jsonb;
  exact_audit_count integer;
  configured_service_count integer;
  available_service_count integer;
  disabled_integration_count integer;
  replayed_value boolean;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
  then
    raise exception using message = 'STORYOPS_SETUP_AUTHENTICATION_REQUIRED';
  end if;
  if p_company_id is null or p_command_id is null then
    raise exception 'Stable company and command IDs are required';
  end if;
  if p_request_hash is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
  then
    raise exception 'Request hash must be a lowercase SHA-256 digest';
  end if;
  if length(btrim(coalesce(p_business_name, ''))) not between 2 and 80
    or btrim(p_business_name) ~ '[[:cntrl:]]'
  then
    raise exception 'Business name must be 2-80 printable characters';
  end if;
  if length(btrim(coalesce(p_owner_name, ''))) not between 2 and 80
    or btrim(p_owner_name) ~ '[[:cntrl:]]'
  then
    raise exception 'Owner name must be 2-80 printable characters';
  end if;
  if coalesce(p_home_postal_code, '') !~ '^[0-9]{5}$' then
    raise exception 'Home postal code must contain five digits';
  end if;
  if p_timezone <> 'America/Chicago' then
    raise exception 'Single-company DFW V1 requires America/Chicago';
  end if;
  if not coalesce(p_policy_acknowledged, false) then
    raise exception 'Setup policy acknowledgement is required';
  end if;
  if coalesce(cardinality(p_enabled_service_codes), 0) < 1
    or cardinality(p_enabled_service_codes) > 5
    or not (
      p_enabled_service_codes
      <@ array[
        'pressure-wash-flatwork',
        'soft-wash-house',
        'gutter-cleaning',
        'roof-washing',
        'window-cleaning'
      ]::text[]
    )
    or (
      select count(*) <> count(distinct candidate)
      from unnest(p_enabled_service_codes) candidate
    )
  then
    raise exception 'Select one to five unique supported services';
  end if;

  current_setup_input := jsonb_build_object(
    'businessName', btrim(p_business_name),
    'ownerName', btrim(p_owner_name),
    'homePostalCode', p_home_postal_code,
    'timezone', p_timezone,
    'enabledServiceCodes', to_jsonb(p_enabled_service_codes),
    'policyAcknowledged', true
  );

  select membership.*
  into actor_membership
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;

  select company.*
  into company_record
  from public.companies company
  where company.id = p_company_id;

  select receipt.*
  into receipt_record
  from private.storyops_setup_receipts receipt
  where receipt.company_id = p_company_id;

  if company_record.id is not null and actor_membership.id is null then
    raise exception 'No active company membership';
  end if;
  if actor_membership.id is not null
    and actor_membership.role <> 'owner'
  then
    raise exception 'Only an owner can complete company setup';
  end if;

  if receipt_record.company_id is not null then
    if receipt_record.command_id <> p_command_id
      or receipt_record.request_hash <> p_request_hash
      or receipt_record.setup_input <> current_setup_input
    then
      raise exception
        'Company setup is already complete with a different request';
    end if;

    return jsonb_build_object(
      'schemaVersion', 'storyops-live-setup-v1',
      'status', 'configured',
      'companyId', receipt_record.company_id,
      'role', 'owner',
      'companyStatus', receipt_record.company_status,
      'setupComplete', true,
      'requiresLaunchReview', true,
      'replayed', true,
      'commandId', receipt_record.command_id,
      'requestHash', receipt_record.request_hash,
      'serviceCount', receipt_record.service_count,
      'availableServiceCount', receipt_record.available_service_count,
      'integrationsDisabled', receipt_record.integrations_disabled,
      'serverTime', receipt_record.setup_completed_at
    );
  end if;

  if company_record.id is not null
    and coalesce(
      (company_record.settings ->> 'setupWizardCompleted')::boolean,
      false
    )
  then
    raise exception using
      message = 'STORYOPS_SETUP_RECEIPT_EVIDENCE_REQUIRED';
  end if;

  adapter_result := private.complete_storyops_setup_v1_1_adapter(
    p_company_id,
    p_command_id,
    p_request_hash,
    p_business_name,
    p_owner_name,
    p_home_postal_code,
    p_timezone,
    p_enabled_service_codes,
    p_policy_acknowledged
  );

  select company.*
  into strict company_record
  from public.companies company
  where company.id = p_company_id;

  select count(*)::integer
  into exact_audit_count
  from public.audit_events event
  where event.company_id = p_company_id
    and event.action = 'company.setup_completed'
    and event.entity_type = 'company'
    and event.entity_id = p_company_id
    and event.actor_type = 'user'
    and event.request_id = p_command_id::text
    and event.after_data -> 'serviceCodes'
      = current_setup_input -> 'enabledServiceCodes'
    and event.after_data -> 'companyStatus' = '"setup"'::jsonb
    and event.after_data -> 'providers' = '"disabled"'::jsonb
    and event.after_data -> 'priceBook' = '"draft"'::jsonb
    and event.after_data -> 'terms' = '"draft"'::jsonb
    and event.after_data -> 'retentionPolicy' = '"draft"'::jsonb
    and event.after_data -> 'launchAuthorized' = 'false'::jsonb;

  if exact_audit_count <> 1
    or company_record.settings ->> 'setupCommandId'
      <> p_command_id::text
    or company_record.settings ->> 'setupRequestHash'
      <> p_request_hash
    or company_record.settings -> 'setupInput'
      <> current_setup_input
    or nullif(
      company_record.settings ->> 'setupCompletedAt',
      ''
    ) is null
    or adapter_result ->> 'companyStatus' <> 'setup'
    or (adapter_result ->> 'availableServiceCount')::integer <> 5
    or (adapter_result ->> 'integrationsDisabled')::integer <> 11
  then
    raise exception 'STORYOPS_SETUP_RECEIPT_RECONCILIATION_FAILED';
  end if;

  select event.*
  into strict exact_audit_record
  from public.audit_events event
  where event.company_id = p_company_id
    and event.action = 'company.setup_completed'
    and event.entity_type = 'company'
    and event.entity_id = p_company_id
    and event.actor_type = 'user'
    and event.request_id = p_command_id::text
    and event.after_data -> 'serviceCodes'
      = current_setup_input -> 'enabledServiceCodes'
    and event.after_data -> 'companyStatus' = '"setup"'::jsonb
    and event.after_data -> 'providers' = '"disabled"'::jsonb
    and event.after_data -> 'priceBook' = '"draft"'::jsonb
    and event.after_data -> 'terms' = '"draft"'::jsonb
    and event.after_data -> 'retentionPolicy' = '"draft"'::jsonb
    and event.after_data -> 'launchAuthorized' = 'false'::jsonb;

  select count(*)::integer
  into configured_service_count
  from public.service_catalog service
  where service.company_id = p_company_id
    and service.code = any(p_enabled_service_codes)
    and not service.active;

  select count(*)::integer
  into available_service_count
  from public.service_catalog service
  where service.company_id = p_company_id
    and service.code = any(array[
      'pressure-wash-flatwork',
      'soft-wash-house',
      'gutter-cleaning',
      'roof-washing',
      'window-cleaning'
    ]::text[])
    and not service.active;

  select count(*)::integer
  into disabled_integration_count
  from public.integration_connections connection
  where connection.company_id = p_company_id
    and connection.mode = 'disabled'
    and connection.status = 'disabled';

  if configured_service_count <> cardinality(p_enabled_service_codes)
    or available_service_count <> 5
    or disabled_integration_count <> 11
    or (company_record.settings ->> 'setupCompletedAt')::timestamptz
      is distinct from exact_audit_record.occurred_at
    or (adapter_result ->> 'serverTime')::timestamptz
      is distinct from exact_audit_record.occurred_at
  then
    raise exception 'STORYOPS_SETUP_RECEIPT_RECONCILIATION_FAILED';
  end if;

  insert into private.storyops_setup_receipts(
    company_id,
    command_id,
    request_hash,
    setup_input,
    company_status,
    service_count,
    available_service_count,
    integrations_disabled,
    setup_completed_at,
    evidence_audit_event_id
  )
  values (
    p_company_id,
    p_command_id,
    p_request_hash,
    current_setup_input,
    'setup',
    configured_service_count,
    5,
    11,
    exact_audit_record.occurred_at,
    exact_audit_record.id
  )
  on conflict (company_id) do nothing;

  select receipt.*
  into strict receipt_record
  from private.storyops_setup_receipts receipt
  where receipt.company_id = p_company_id;

  if receipt_record.command_id <> p_command_id
    or receipt_record.request_hash <> p_request_hash
    or receipt_record.setup_input <> current_setup_input
  then
    raise exception
      'Company setup is already complete with a different request';
  end if;

  replayed_value := coalesce(
    (adapter_result ->> 'replayed')::boolean,
    false
  );

  return jsonb_build_object(
    'schemaVersion', 'storyops-live-setup-v1',
    'status', 'configured',
    'companyId', receipt_record.company_id,
    'role', 'owner',
    'companyStatus', receipt_record.company_status,
    'setupComplete', true,
    'requiresLaunchReview', true,
    'replayed', replayed_value,
    'commandId', receipt_record.command_id,
    'requestHash', receipt_record.request_hash,
    'serviceCount', receipt_record.service_count,
    'availableServiceCount', receipt_record.available_service_count,
    'integrationsDisabled', receipt_record.integrations_disabled,
    'serverTime', receipt_record.setup_completed_at
  );
end;
$$;

revoke all on function public.complete_storyops_setup(
  uuid, uuid, text, text, text, text, text, text[], boolean
) from public, anon, authenticated, service_role;
grant execute on function public.complete_storyops_setup(
  uuid, uuid, text, text, text, text, text, text[], boolean
) to authenticated;

comment on function public.complete_storyops_setup(
  uuid, uuid, text, text, text, text, text, text[], boolean
) is
  'Completes setup once and replays only the immutable private receipt proven by the exact append-only setup audit event.';

create trigger companies_guard_system_state
before update on public.companies
for each row execute function public.guard_company_system_state();

comment on table private.storyops_setup_receipts is
  'Private append-only setup command receipts; mutable lifecycle and provider state never reconstruct replay output.';

comment on table private.storyops_setup_receipt_quarantines is
  'Private append-only ledger of completed legacy companies whose setup receipt evidence was missing, ambiguous, invalid, or contradictory.';
