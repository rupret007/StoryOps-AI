\set ON_ERROR_STOP on

begin;

\echo '1/8 only authenticated back-office callers receive the atomic intake RPC'
do $$
begin
  if not has_function_privilege(
    'authenticated',
    'public.create_storyops_customer_property(uuid,uuid,jsonb,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.create_storyops_customer_property(uuid,uuid,jsonb,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'service_role',
    'public.create_storyops_customer_property(uuid,uuid,jsonb,text)',
    'EXECUTE'
  ) then
    raise exception 'Atomic customer/property RPC ACL is not least privilege';
  end if;
end;
$$;

insert into public.companies(id, name, status)
values (
  '94800000-0000-4000-8000-000000000001',
  'Atomic intake inactive tenant',
  'active'
);
insert into public.company_memberships(
  id, company_id, user_id, role, active
)
values (
  '94800000-0000-4000-8000-000000000002',
  '94800000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000104',
  'owner',
  true
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

\echo '2/8 customer and first property commit atomically with normalized facts'
do $$
declare
  company_id_value constant uuid :=
    '10000000-0000-4000-8000-000000000001';
  operation_id_value constant uuid :=
    '94800000-0000-4000-8000-000000000010';
  customer_id_value constant uuid :=
    '94800000-0000-4000-8000-000000000101';
  property_id_value constant uuid :=
    '94800000-0000-4000-8000-000000000201';
  payload_value jsonb := jsonb_build_object(
    'schemaVersion', 'storyops-customer-property-create-v1',
    'customer', jsonb_build_object(
      'id', customer_id_value,
      'kind', 'individual',
      'displayName', '  Atomic Customer  ',
      'email', 'atomic.customer@example.test',
      'phone', '+12145550123',
      'acquisitionSource', 'manual'
    ),
    'property', jsonb_build_object(
      'id', property_id_value,
      'name', '  Atomic Residence  ',
      'propertyType', 'single_family',
      'serviceAddress', jsonb_build_object(
        'line1', '1234 Exact Address Lane',
        'line2', null,
        'city', 'Dallas',
        'region', 'TX',
        'postalCode', '75201',
        'country', 'us'
      ),
      'knownHazards', jsonb_build_array('Locked rear gate')
    )
  );
  receipt jsonb;
begin
  receipt := public.create_storyops_customer_property(
    company_id_value,
    operation_id_value,
    payload_value,
    public.storyops_json_sha256(payload_value)
  );
  if receipt ->> 'schemaVersion'
      <> 'storyops-customer-property-receipt-v1'
    or (receipt ->> 'customerId')::uuid <> customer_id_value
    or (receipt ->> 'propertyId')::uuid <> property_id_value
    or (receipt ->> 'customerVersion')::integer <> 1
    or (receipt ->> 'propertyVersion')::integer <> 1
    or (receipt ->> 'replayed')::boolean
  then
    raise exception 'Atomic receipt was invalid: %', receipt;
  end if;
  if not exists (
    select 1
    from public.customers customer
    where customer.company_id = company_id_value
      and customer.id = customer_id_value
      and customer.display_name = 'Atomic Customer'
      and customer.email = 'atomic.customer@example.test'
  ) or not exists (
    select 1
    from public.properties property
    where property.company_id = company_id_value
      and property.id = property_id_value
      and property.customer_id = customer_id_value
      and property.name = 'Atomic Residence'
      and property.service_address ->> 'country' = 'US'
      and property.latitude is null
      and property.longitude is null
      and property.geocode_candidate_id is null
  ) then
    raise exception 'Atomic rows were missing or not normalized';
  end if;
end;
$$;

\echo '3/8 exact replay returns the original receipt without duplicate rows or audit'
do $$
declare
  company_id_value constant uuid :=
    '10000000-0000-4000-8000-000000000001';
  operation_id_value constant uuid :=
    '94800000-0000-4000-8000-000000000010';
  customer_id_value constant uuid :=
    '94800000-0000-4000-8000-000000000101';
  property_id_value constant uuid :=
    '94800000-0000-4000-8000-000000000201';
  payload_value jsonb := jsonb_build_object(
    'schemaVersion', 'storyops-customer-property-create-v1',
    'customer', jsonb_build_object(
      'id', customer_id_value,
      'kind', 'individual',
      'displayName', '  Atomic Customer  ',
      'email', 'atomic.customer@example.test',
      'phone', '+12145550123',
      'acquisitionSource', 'manual'
    ),
    'property', jsonb_build_object(
      'id', property_id_value,
      'name', '  Atomic Residence  ',
      'propertyType', 'single_family',
      'serviceAddress', jsonb_build_object(
        'line1', '1234 Exact Address Lane',
        'line2', null,
        'city', 'Dallas',
        'region', 'TX',
        'postalCode', '75201',
        'country', 'us'
      ),
      'knownHazards', jsonb_build_array('Locked rear gate')
    )
  );
  replay jsonb;
begin
  replay := public.create_storyops_customer_property(
    company_id_value,
    operation_id_value,
    payload_value,
    public.storyops_json_sha256(payload_value)
  );
  if not (replay ->> 'replayed')::boolean
    or (select count(*) from public.customers where id = customer_id_value) <> 1
    or (select count(*) from public.properties where id = property_id_value) <> 1
    or (
      select count(*)
      from public.audit_events audit
      where audit.company_id = company_id_value
        and audit.action = 'customer_property.created_atomically'
        and audit.request_id = operation_id_value::text
    ) <> 1
  then
    raise exception 'Atomic replay duplicated durable effects: %', replay;
  end if;
end;
$$;

\echo '4/8 operation reuse with a different full payload is rejected'
do $$
declare
  payload_value jsonb := jsonb_build_object(
    'schemaVersion', 'storyops-customer-property-create-v1',
    'customer', jsonb_build_object(
      'id', '94800000-0000-4000-8000-000000000101'::uuid,
      'kind', 'individual',
      'displayName', 'Different Customer'
    ),
    'property', jsonb_build_object(
      'id', '94800000-0000-4000-8000-000000000201'::uuid,
      'name', 'Atomic Residence',
      'propertyType', 'single_family',
      'serviceAddress', jsonb_build_object(
        'line1', '1234 Exact Address Lane',
        'city', 'Dallas',
        'region', 'TX',
        'postalCode', '75201',
        'country', 'US'
      ),
      'knownHazards', '[]'::jsonb
    )
  );
  denied boolean := false;
begin
  begin
    perform public.create_storyops_customer_property(
      '10000000-0000-4000-8000-000000000001',
      '94800000-0000-4000-8000-000000000010',
      payload_value,
      public.storyops_json_sha256(payload_value)
    );
  exception when others then
    denied := sqlerrm = 'CUSTOMER_PROPERTY_IDEMPOTENCY_CONFLICT';
  end;
  if not denied then
    raise exception 'Different atomic payload reused an operation identity';
  end if;
end;
$$;

\echo '5/8 a property failure rolls back its preceding customer and reservations'
do $$
declare
  customer_id_value constant uuid :=
    '94800000-0000-4000-8000-000000000102';
  operation_id_value constant uuid :=
    '94800000-0000-4000-8000-000000000011';
  payload_value jsonb := jsonb_build_object(
    'schemaVersion', 'storyops-customer-property-create-v1',
    'customer', jsonb_build_object(
      'id', customer_id_value,
      'kind', 'business',
      'displayName', 'Must Roll Back'
    ),
    'property', jsonb_build_object(
      'id', '10000000-0000-4000-8000-000000000211'::uuid,
      'name', 'Conflicting Property',
      'propertyType', 'commercial',
      'serviceAddress', jsonb_build_object(
        'line1', '999 Conflict Road',
        'city', 'Dallas',
        'region', 'TX',
        'postalCode', '75201',
        'country', 'US'
      ),
      'knownHazards', '[]'::jsonb
    )
  );
  denied boolean := false;
begin
  begin
    perform public.create_storyops_customer_property(
      '10000000-0000-4000-8000-000000000001',
      operation_id_value,
      payload_value,
      public.storyops_json_sha256(payload_value)
    );
  exception when others then
    denied := true;
  end;
  if not denied
    or exists (select 1 from public.customers where id = customer_id_value)
    or exists (
      select 1
      from public.idempotency_keys idempotency
      where idempotency.company_id =
          '10000000-0000-4000-8000-000000000001'
        and idempotency.key = operation_id_value::text
        and idempotency.scope in (
          'customer-property-create-v1',
          'workspace-command-v1'
        )
    )
  then
    raise exception 'Failed property creation stranded customer state';
  end if;
end;
$$;

\echo '6/8 hash and exact typed-payload mismatches fail before mutation'
do $$
declare
  customer_id_value constant uuid :=
    '94800000-0000-4000-8000-000000000103';
  payload_value jsonb := jsonb_build_object(
    'schemaVersion', 'storyops-customer-property-create-v1',
    'customer', jsonb_build_object(
      'id', customer_id_value,
      'kind', 'individual',
      'displayName', 12345
    ),
    'property', jsonb_build_object(
      'id', '94800000-0000-4000-8000-000000000203'::uuid,
      'name', 'Typed Property',
      'propertyType', 'single_family',
      'serviceAddress', jsonb_build_object(
        'line1', '1234 Typed Value Lane',
        'city', 'Dallas',
        'region', 'TX',
        'postalCode', '75201',
        'country', 'US'
      ),
      'knownHazards', '[]'::jsonb
    )
  );
  typed_denied boolean := false;
  hash_denied boolean := false;
begin
  begin
    perform public.create_storyops_customer_property(
      '10000000-0000-4000-8000-000000000001',
      '94800000-0000-4000-8000-000000000013',
      payload_value,
      public.storyops_json_sha256(payload_value)
    );
  exception when others then
    typed_denied := sqlerrm =
      'CUSTOMER_PROPERTY_CUSTOMER_FIELDS_INVALID';
  end;
  payload_value := jsonb_set(
    payload_value,
    '{customer,displayName}',
    '"Typed Customer"'::jsonb
  );
  begin
    perform public.create_storyops_customer_property(
      '10000000-0000-4000-8000-000000000001',
      '94800000-0000-4000-8000-000000000014',
      payload_value,
      repeat('0', 64)
    );
  exception when others then
    hash_denied := sqlerrm = 'CUSTOMER_PROPERTY_REQUEST_HASH_MISMATCH';
  end;
  if not typed_denied
    or not hash_denied
    or exists (select 1 from public.customers where id = customer_id_value)
  then
    raise exception 'Typed payload or request-hash validation failed closed';
  end if;
end;
$$;

\echo '7/8 technician and cross-tenant callers cannot create customer scope'
do $$
declare
  payload_value jsonb := jsonb_build_object(
    'schemaVersion', 'storyops-customer-property-create-v1',
    'customer', jsonb_build_object(
      'id', '94800000-0000-4000-8000-000000000104'::uuid,
      'kind', 'individual',
      'displayName', 'Unauthorized Customer'
    ),
    'property', jsonb_build_object(
      'id', '94800000-0000-4000-8000-000000000204'::uuid,
      'name', 'Unauthorized Property',
      'propertyType', 'single_family',
      'serviceAddress', jsonb_build_object(
        'line1', '1234 Unauthorized Lane',
        'city', 'Dallas',
        'region', 'TX',
        'postalCode', '75201',
        'country', 'US'
      ),
      'knownHazards', '[]'::jsonb
    )
  );
  role_denied boolean := false;
  tenant_denied boolean := false;
  role_error text;
  tenant_error text;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"10000000-0000-4000-8000-000000000103","role":"authenticated"}',
    true
  );
  perform set_config(
    'request.jwt.claim.sub',
    '10000000-0000-4000-8000-000000000103',
    true
  );
  begin
    perform public.create_storyops_customer_property(
      '10000000-0000-4000-8000-000000000001',
      '94800000-0000-4000-8000-000000000015',
      payload_value,
      public.storyops_json_sha256(payload_value)
    );
  exception when others then
    role_error := sqlerrm;
    role_denied := role_error = 'CUSTOMER_PROPERTY_BACK_OFFICE_REQUIRED';
  end;
  perform set_config(
    'request.jwt.claims',
    '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
    true
  );
  perform set_config(
    'request.jwt.claim.sub',
    '10000000-0000-4000-8000-000000000101',
    true
  );
  begin
    perform public.create_storyops_customer_property(
      '94800000-0000-4000-8000-000000000001',
      '94800000-0000-4000-8000-000000000016',
      payload_value,
      public.storyops_json_sha256(payload_value)
    );
  exception when others then
    tenant_error := sqlerrm;
    tenant_denied := tenant_error = 'CUSTOMER_PROPERTY_BACK_OFFICE_REQUIRED';
  end;
  if not role_denied or not tenant_denied then
    raise exception 'Role/company tenant isolation failed: role=%, tenant=%',
      role_error,
      tenant_error;
  end if;
end;
$$;

\echo '8/8 a paused company is not a mutation surface even for its owner'
update public.companies
set status = 'paused'
where id = '94800000-0000-4000-8000-000000000001';

do $$
declare
  payload_value jsonb := jsonb_build_object(
    'schemaVersion', 'storyops-customer-property-create-v1',
    'customer', jsonb_build_object(
      'id', '94800000-0000-4000-8000-000000000105'::uuid,
      'kind', 'individual',
      'displayName', 'Paused Customer'
    ),
    'property', jsonb_build_object(
      'id', '94800000-0000-4000-8000-000000000205'::uuid,
      'name', 'Paused Property',
      'propertyType', 'single_family',
      'serviceAddress', jsonb_build_object(
        'line1', '1234 Paused Company Lane',
        'city', 'Dallas',
        'region', 'TX',
        'postalCode', '75201',
        'country', 'US'
      ),
      'knownHazards', '[]'::jsonb
    )
  );
  denied boolean := false;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
    true
  );
  perform set_config(
    'request.jwt.claim.sub',
    '10000000-0000-4000-8000-000000000104',
    true
  );
  begin
    perform public.create_storyops_customer_property(
      '94800000-0000-4000-8000-000000000001',
      '94800000-0000-4000-8000-000000000017',
      payload_value,
      public.storyops_json_sha256(payload_value)
    );
  exception when others then
    denied := sqlerrm = 'CUSTOMER_PROPERTY_COMPANY_NOT_ACTIVE';
  end;
  if not denied then
    raise exception 'Paused company accepted atomic customer/property intake';
  end if;
end;
$$;

rollback;
