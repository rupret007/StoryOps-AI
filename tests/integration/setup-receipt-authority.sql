\set ON_ERROR_STOP on

begin;

\echo '1/4 exact legacy setup audit evidence backfills one immutable receipt and completion timestamp'
insert into auth.users(
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
)
values (
  '00000000-0000-0000-0000-000000000000',
  '60000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'setup-receipt-owner@example.test',
  extensions.crypt(
    'LocalRegressionOnly1!',
    extensions.gen_salt('bf')
  ),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"full_name":"Receipt Authority Owner"}',
  now(),
  now(),
  '',
  '',
  '',
  ''
);

insert into public.companies(
  id,
  name,
  timezone,
  currency,
  status,
  settings
)
values
  (
    '60000000-0000-4000-8000-000000000010',
    'Exact Legacy Setup',
    'America/Chicago',
    'USD',
    'setup',
    jsonb_build_object(
      'setupWizardCompleted', true,
      'setupCommandId', '60000000-0000-4000-8000-000000000011',
      'setupRequestHash', repeat('6', 64),
      'setupInput', jsonb_build_object(
        'businessName', 'Exact Legacy Setup',
        'ownerName', 'Receipt Authority Owner',
        'homePostalCode', '76051',
        'timezone', 'America/Chicago',
        'enabledServiceCodes', jsonb_build_array(
          'pressure-wash-flatwork',
          'gutter-cleaning'
        ),
        'policyAcknowledged', true
      ),
      'launchAuthorized', false
    )
  ),
  (
    '60000000-0000-4000-8000-000000000020',
    'Missing Legacy Evidence',
    'America/Chicago',
    'USD',
    'setup',
    jsonb_build_object(
      'setupWizardCompleted', true,
      'setupCommandId', '60000000-0000-4000-8000-000000000021',
      'setupRequestHash', repeat('7', 64),
      'setupInput', jsonb_build_object(
        'businessName', 'Missing Legacy Evidence',
        'ownerName', 'Receipt Authority Owner',
        'homePostalCode', '76051',
        'timezone', 'America/Chicago',
        'enabledServiceCodes', jsonb_build_array(
          'soft-wash-house'
        ),
        'policyAcknowledged', true
      ),
      'launchAuthorized', false
    )
  ),
  (
    '60000000-0000-4000-8000-000000000030',
    'Ambiguous Legacy Evidence',
    'America/Chicago',
    'USD',
    'setup',
    jsonb_build_object(
      'setupWizardCompleted', true,
      'setupCommandId', '60000000-0000-4000-8000-000000000031',
      'setupRequestHash', repeat('8', 64),
      'setupInput', jsonb_build_object(
        'businessName', 'Ambiguous Legacy Evidence',
        'ownerName', 'Receipt Authority Owner',
        'homePostalCode', '76051',
        'timezone', 'America/Chicago',
        'enabledServiceCodes', jsonb_build_array(
          'soft-wash-house',
          'roof-washing',
          'window-cleaning'
        ),
        'policyAcknowledged', true
      ),
      'launchAuthorized', false
    )
  );

insert into public.company_memberships(
  company_id,
  user_id,
  role,
  active
)
values
  (
    '60000000-0000-4000-8000-000000000010',
    '60000000-0000-4000-8000-000000000001',
    'owner',
    true
  ),
  (
    '60000000-0000-4000-8000-000000000020',
    '60000000-0000-4000-8000-000000000001',
    'owner',
    true
  ),
  (
    '60000000-0000-4000-8000-000000000030',
    '60000000-0000-4000-8000-000000000001',
    'owner',
    true
  );

insert into public.integration_connections(
  company_id,
  provider,
  mode,
  status,
  configuration,
  capabilities
)
select
  company_id,
  provider,
  'disabled',
  'disabled',
  '{}'::jsonb,
  '{}'::text[]
from unnest(array[
  '60000000-0000-4000-8000-000000000010',
  '60000000-0000-4000-8000-000000000020',
  '60000000-0000-4000-8000-000000000030'
]::uuid[]) company_id
cross join unnest(array[
  'openai',
  'twilio',
  'email',
  'stripe',
  'google_calendar',
  'maps',
  'nws',
  'vroom',
  'signed_storage_targets',
  'quickbooks_export'
]::text[]) provider
on conflict (company_id, provider) do nothing;

insert into public.audit_events(
  id,
  company_id,
  occurred_at,
  actor_type,
  actor_id,
  action,
  entity_type,
  entity_id,
  after_data,
  request_id
)
values
  (
    '60000000-0000-4000-8000-000000000012',
    '60000000-0000-4000-8000-000000000010',
    '2026-07-15T14:30:00Z',
    'user',
    '60000000-0000-4000-8000-000000000001',
    'company.setup_completed',
    'company',
    '60000000-0000-4000-8000-000000000010',
    jsonb_build_object(
      'companyCreated', false,
      'serviceCodes', jsonb_build_array(
        'pressure-wash-flatwork',
        'gutter-cleaning'
      ),
      'companyStatus', 'setup',
      'providers', 'disabled',
      'priceBook', 'draft',
      'terms', 'draft',
      'retentionPolicy', 'draft',
      'launchAuthorized', false
    ),
    '60000000-0000-4000-8000-000000000011'
  ),
  (
    '60000000-0000-4000-8000-000000000032',
    '60000000-0000-4000-8000-000000000030',
    '2026-07-16T14:30:00Z',
    'user',
    '60000000-0000-4000-8000-000000000001',
    'company.setup_completed',
    'company',
    '60000000-0000-4000-8000-000000000030',
    jsonb_build_object(
      'companyCreated', false,
      'serviceCodes', jsonb_build_array(
        'soft-wash-house',
        'roof-washing',
        'window-cleaning'
      ),
      'companyStatus', 'setup',
      'providers', 'disabled',
      'priceBook', 'draft',
      'terms', 'draft',
      'retentionPolicy', 'draft',
      'launchAuthorized', false
    ),
    '60000000-0000-4000-8000-000000000031'
  ),
  (
    '60000000-0000-4000-8000-000000000033',
    '60000000-0000-4000-8000-000000000030',
    '2026-07-16T14:30:01Z',
    'user',
    '60000000-0000-4000-8000-000000000001',
    'company.setup_completed',
    'company',
    '60000000-0000-4000-8000-000000000030',
    jsonb_build_object(
      'companyCreated', false,
      'serviceCodes', jsonb_build_array(
        'soft-wash-house',
        'roof-washing',
        'window-cleaning'
      ),
      'companyStatus', 'setup',
      'providers', 'disabled',
      'priceBook', 'draft',
      'terms', 'draft',
      'retentionPolicy', 'draft',
      'launchAuthorized', false
    ),
    '60000000-0000-4000-8000-000000000031'
  );

select private.backfill_storyops_setup_receipts_v1_2();

do $$
begin
  if (
    select company.settings ->> 'setupCompletedAt'
    from public.companies company
    where company.id = '60000000-0000-4000-8000-000000000010'
  )::timestamptz is distinct from '2026-07-15T14:30:00Z'::timestamptz then
    raise exception
      'Exact legacy audit timestamp was not installed as setupCompletedAt';
  end if;

  if not exists (
    select 1
    from private.storyops_setup_receipts receipt
    where receipt.company_id =
        '60000000-0000-4000-8000-000000000010'
      and receipt.command_id =
        '60000000-0000-4000-8000-000000000011'
      and receipt.request_hash = repeat('6', 64)
      and receipt.company_status = 'setup'
      and receipt.service_count = 2
      and receipt.available_service_count = 5
      and receipt.integrations_disabled = 11
      and receipt.setup_completed_at =
        '2026-07-15T14:30:00Z'::timestamptz
      and receipt.evidence_audit_event_id =
        '60000000-0000-4000-8000-000000000012'
  ) then
    raise exception 'Exact legacy setup receipt was not persisted';
  end if;

  if (
    select company.settings ? 'setupCompletedAt'
    from public.companies company
    where company.id = '60000000-0000-4000-8000-000000000020'
  ) or (
    select company.settings ? 'setupCompletedAt'
    from public.companies company
    where company.id = '60000000-0000-4000-8000-000000000030'
  ) then
    raise exception
      'Missing or ambiguous legacy evidence invented a completion timestamp';
  end if;

  if not exists (
    select 1
    from private.storyops_setup_receipt_quarantines quarantine
    where quarantine.company_id =
        '60000000-0000-4000-8000-000000000020'
      and quarantine.reason = 'missing_setup_audit'
      and quarantine.setup_audit_count = 0
      and quarantine.exact_audit_count = 0
  ) or not exists (
    select 1
    from private.storyops_setup_receipt_quarantines quarantine
    where quarantine.company_id =
        '60000000-0000-4000-8000-000000000030'
      and quarantine.reason = 'ambiguous_setup_audit'
      and quarantine.setup_audit_count = 2
      and quarantine.exact_audit_count = 2
  ) then
    raise exception
      'Missing and ambiguous setup evidence was not quarantined exactly';
  end if;
end;
$$;

\echo '2/4 activated company and provider changes cannot alter exact setup replay facts'
update public.companies
set status = 'active'
where id = '60000000-0000-4000-8000-000000000010';

update public.integration_connections
set
  mode = 'sandbox',
  status = 'healthy',
  owner_enabled = true,
  environment_mode = 'sandbox',
  environment_capabilities = array['responses']::text[],
  environment_status = 'healthy',
  environment_fingerprint = repeat('a', 64),
  environment_probe_run_id =
    '60000000-0000-4000-8000-000000000013',
  environment_checked_at = now(),
  environment_expires_at = now() + interval '15 minutes',
  activated_by_user_id =
    '60000000-0000-4000-8000-000000000001',
  activated_at = now(),
  disabled_at = null,
  activation_command_id =
    '60000000-0000-4000-8000-000000000014'
where company_id = '60000000-0000-4000-8000-000000000010'
  and provider = 'openai';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  receipt jsonb;
  second_replay jsonb;
begin
  receipt := public.complete_storyops_setup(
    '60000000-0000-4000-8000-000000000010',
    '60000000-0000-4000-8000-000000000011',
    repeat('6', 64),
    'Exact Legacy Setup',
    'Receipt Authority Owner',
    '76051',
    'America/Chicago',
    array[
      'pressure-wash-flatwork',
      'gutter-cleaning'
    ]::text[],
    true
  );

  second_replay := public.complete_storyops_setup(
    '60000000-0000-4000-8000-000000000010',
    '60000000-0000-4000-8000-000000000011',
    repeat('6', 64),
    'Exact Legacy Setup',
    'Receipt Authority Owner',
    '76051',
    'America/Chicago',
    array[
      'pressure-wash-flatwork',
      'gutter-cleaning'
    ]::text[],
    true
  );

  if receipt ->> 'schemaVersion' <> 'storyops-live-setup-v1'
    or receipt ->> 'status' <> 'configured'
    or not (receipt ->> 'replayed')::boolean
    or receipt ->> 'companyStatus' <> 'setup'
    or (receipt ->> 'serviceCount')::integer <> 2
    or (receipt ->> 'availableServiceCount')::integer <> 5
    or (receipt ->> 'integrationsDisabled')::integer <> 11
    or (receipt ->> 'serverTime')::timestamptz
      is distinct from '2026-07-15T14:30:00Z'::timestamptz
    or second_replay ->> 'serverTime' <> receipt ->> 'serverTime'
  then
    raise exception
      'Mutable lifecycle/provider state changed setup replay: %',
      receipt;
  end if;
end;
$$;

\echo '3/4 missing or ambiguous legacy evidence fails closed instead of invoking mutable replay reconstruction'
do $$
declare
  missing_blocked boolean := false;
  ambiguous_blocked boolean := false;
begin
  begin
    perform public.complete_storyops_setup(
      '60000000-0000-4000-8000-000000000020',
      '60000000-0000-4000-8000-000000000021',
      repeat('7', 64),
      'Missing Legacy Evidence',
      'Receipt Authority Owner',
      '76051',
      'America/Chicago',
      array['soft-wash-house']::text[],
      true
    );
  exception
    when others then
      if sqlerrm = 'STORYOPS_SETUP_RECEIPT_EVIDENCE_REQUIRED' then
        missing_blocked := true;
      else
        raise;
      end if;
  end;

  begin
    perform public.complete_storyops_setup(
      '60000000-0000-4000-8000-000000000030',
      '60000000-0000-4000-8000-000000000031',
      repeat('8', 64),
      'Ambiguous Legacy Evidence',
      'Receipt Authority Owner',
      '76051',
      'America/Chicago',
      array[
        'soft-wash-house',
        'roof-washing',
        'window-cleaning'
      ]::text[],
      true
    );
  exception
    when others then
      if sqlerrm = 'STORYOPS_SETUP_RECEIPT_EVIDENCE_REQUIRED' then
        ambiguous_blocked := true;
      else
        raise;
      end if;
  end;

  if not missing_blocked or not ambiguous_blocked then
    raise exception
      'Unsafe legacy setup replay did not fail closed';
  end if;
end;
$$;

\echo '4/4 receipt/quarantine evidence is append-only, setupCompletedAt stays guarded, and the public ACL is unchanged'
reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

do $$
declare
  receipt_update_blocked boolean := false;
  quarantine_update_blocked boolean := false;
begin
  begin
    update private.storyops_setup_receipts
    set integrations_disabled = 10
    where company_id = '60000000-0000-4000-8000-000000000010';
  exception
    when others then
      if position('append-only' in sqlerrm) > 0 then
        receipt_update_blocked := true;
      else
        raise;
      end if;
  end;

  begin
    update private.storyops_setup_receipt_quarantines
    set reason = 'invalid_setup_input'
    where company_id = '60000000-0000-4000-8000-000000000020';
  exception
    when others then
      if position('append-only' in sqlerrm) > 0 then
        quarantine_update_blocked := true;
      else
        raise;
      end if;
  end;

  if not receipt_update_blocked or not quarantine_update_blocked then
    raise exception 'Setup receipt authority is not append-only';
  end if;

  if not has_function_privilege(
    'authenticated',
    'public.complete_storyops_setup(uuid,uuid,text,text,text,text,text,text[],boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.complete_storyops_setup(uuid,uuid,text,text,text,text,text,text[],boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'service_role',
    'public.complete_storyops_setup(uuid,uuid,text,text,text,text,text,text[],boolean)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'private.complete_storyops_setup_v1_1_adapter(uuid,uuid,text,text,text,text,text,text[],boolean)',
    'EXECUTE'
  ) or has_table_privilege(
    'authenticated',
    'private.storyops_setup_receipts',
    'SELECT'
  ) then
    raise exception 'Setup receipt migration changed the finite API ACL';
  end if;
end;
$$;

grant select, update(settings) on public.companies to authenticated;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"60000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '60000000-0000-4000-8000-000000000001',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  protected boolean := false;
begin
  begin
    update public.companies
    set settings = jsonb_set(
      settings,
      '{setupCompletedAt}',
      to_jsonb('2026-07-20T12:00:00Z'::timestamptz),
      false
    )
    where id = '60000000-0000-4000-8000-000000000010';
  exception
    when others then
      if position(
        'setup and launch evidence is server-managed'
        in sqlerrm
      ) > 0 then
        protected := true;
      else
        raise;
      end if;
  end;

  if not protected then
    raise exception
      'The company setupCompletedAt guard was not reinstalled';
  end if;
end;
$$;

rollback;

\echo 'StoryOps immutable setup receipt authority contract passed.'
