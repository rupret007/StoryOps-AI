\set ON_ERROR_STOP on

-- Self-contained least-privilege Stripe billing identity/mapping contract.

begin;

\echo '1/4 Stripe resolver has RPC-only table access'
do $$
begin
  if has_table_privilege(
    'service_role',
    'public.customers',
    'SELECT'
  ) or has_table_privilege(
    'service_role',
    'public.provider_customers',
    'SELECT'
  ) or has_table_privilege(
    'service_role',
    'public.provider_customers',
    'INSERT'
  ) or has_table_privilege(
    'service_role',
    'public.provider_customers',
    'UPDATE'
  ) then
    raise exception 'Stripe service role unexpectedly has direct billing table access';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.resolve_stripe_billing_identity(uuid,uuid)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.save_stripe_customer_mapping(uuid,uuid,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.resolve_stripe_billing_identity(uuid,uuid)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.save_stripe_customer_mapping(uuid,uuid,text,text)',
    'EXECUTE'
  ) then
    raise exception 'Stripe billing RPC privilege boundary is invalid';
  end if;
end;
$$;

insert into public.companies(id, name)
values
  (
    '97000000-0000-4000-8000-000000000001',
    'Stripe mapping contract one'
  ),
  (
    '97000000-0000-4000-8000-000000000002',
    'Stripe mapping contract two'
  );

insert into public.customers(
  id,
  company_id,
  display_name,
  email,
  lifecycle
)
values
  (
    '97000000-0000-4000-8000-000000000201',
    '97000000-0000-4000-8000-000000000001',
    'Morgan Ellis',
    'Morgan@Example.com',
    'active'
  ),
  (
    '97000000-0000-4000-8000-000000000202',
    '97000000-0000-4000-8000-000000000002',
    'Taylor Ellis',
    'taylor@example.com',
    'active'
  );

\echo '2/4 service role resolves minimal identity and saves idempotent mapping'
set local role service_role;
do $$
declare
  identity_decision record;
  saved_decision record;
  duplicate_decision record;
  first_mapping_id uuid;
  result_keys text[];
begin
  select *
  into identity_decision
  from public.resolve_stripe_billing_identity(
    '97000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000201'
  );
  select array_agg(key order by key)
  into result_keys
  from jsonb_object_keys(to_jsonb(identity_decision)) keys(key);
  if not identity_decision.eligible
    or identity_decision.decision_code <> 'ELIGIBLE'
    or identity_decision.customer_id
      <> '97000000-0000-4000-8000-000000000201'
    or identity_decision.billing_name <> 'Morgan Ellis'
    or identity_decision.billing_email <> 'morgan@example.com'
    or identity_decision.provider_customer_id is not null
    or identity_decision.identity_fingerprint !~ '^[a-f0-9]{64}$'
    or result_keys <> array[
      'billing_email',
      'billing_name',
      'customer_id',
      'decision_code',
      'eligible',
      'identity_fingerprint',
      'provider_customer_id'
    ]::text[]
  then
    raise exception 'Stripe identity RPC returned invalid or excessive evidence';
  end if;

  select *
  into saved_decision
  from public.save_stripe_customer_mapping(
    '97000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000201',
    'cus_contract001',
    identity_decision.identity_fingerprint
  );
  if not saved_decision.saved
    or saved_decision.decision_code <> 'SAVED'
    or saved_decision.mapping_id is null
    or saved_decision.provider_customer_id <> 'cus_contract001'
  then
    raise exception 'Stripe mapping was not saved';
  end if;
  first_mapping_id := saved_decision.mapping_id;

  select *
  into duplicate_decision
  from public.save_stripe_customer_mapping(
    '97000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000201',
    'cus_contract001',
    identity_decision.identity_fingerprint
  );
  if not duplicate_decision.saved
    or duplicate_decision.mapping_id <> first_mapping_id
    or duplicate_decision.provider_customer_id <> 'cus_contract001'
  then
    raise exception 'Stripe mapping retry was not idempotent';
  end if;
end;
$$;
reset role;

\echo '3/4 mapping persists once and audit redacts the email snapshot'
do $$
begin
  if (
    select count(*)
    from public.provider_customers
    where company_id = '97000000-0000-4000-8000-000000000001'
      and customer_id = '97000000-0000-4000-8000-000000000201'
      and provider = 'stripe'
      and provider_customer_id = 'cus_contract001'
      and email_snapshot = 'morgan@example.com'
  ) <> 1 or not exists (
    select 1
    from public.audit_events
    where company_id = '97000000-0000-4000-8000-000000000001'
      and entity_type = 'provider_customers'
      and action = 'insert'
      and after_data ? '_source_sha256'
      and after_data -> '_redacted_fields' ? 'email_snapshot'
      and not after_data ? 'email_snapshot'
  ) then
    raise exception 'Stripe mapping persistence or audit redaction is invalid';
  end if;
end;
$$;

\echo '4/4 stale identity and cross-company provider reuse fail closed'
do $$
declare
  original_identity record;
  second_identity record;
  decision record;
begin
  select *
  into original_identity
  from public.resolve_stripe_billing_identity(
    '97000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000201'
  );
  update public.customers
  set email = 'morgan.changed@example.com', version = version + 1
  where id = '97000000-0000-4000-8000-000000000201';

  select *
  into decision
  from public.save_stripe_customer_mapping(
    '97000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000201',
    'cus_contract001',
    original_identity.identity_fingerprint
  );
  if decision.saved or decision.decision_code <> 'IDENTITY_STALE' then
    raise exception 'Stale Stripe identity was accepted';
  end if;

  select *
  into second_identity
  from public.resolve_stripe_billing_identity(
    '97000000-0000-4000-8000-000000000002',
    '97000000-0000-4000-8000-000000000202'
  );
  select *
  into decision
  from public.save_stripe_customer_mapping(
    '97000000-0000-4000-8000-000000000002',
    '97000000-0000-4000-8000-000000000202',
    'cus_contract001',
    second_identity.identity_fingerprint
  );
  if decision.saved or decision.decision_code <> 'MAPPING_CONFLICT' then
    raise exception 'Cross-company Stripe customer reuse was accepted';
  end if;
end;
$$;

rollback;

\echo 'Stripe customer mapping contract: PASS'
