-- Atomic customer/property intake plus a human-reviewed, provider-evidenced
-- geocode workflow. A property is intentionally unschedulable until an owner
-- or dispatcher confirms one exact, fresh live-provider candidate.

create or replace function public.create_storyops_customer_property(
  p_company_id uuid,
  p_operation_id uuid,
  p_payload jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  customer_payload jsonb;
  property_payload jsonb;
  address_payload jsonb;
  customer_id_value uuid;
  property_id_value uuid;
  customer_command_id uuid;
  property_command_id uuid;
  customer_command_hash text;
  property_command_hash text;
  customer_result jsonb;
  property_result jsonb;
  unexpected_key text;
  result jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or actor_user_id is null
    or p_company_id is null
    or p_operation_id is null
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or coalesce(p_request_hash, '') !~ '^[a-f0-9]{64}$'
  then
    raise exception using message = 'CUSTOMER_PROPERTY_INVALID_REQUEST';
  end if;
  if not exists (
    select 1
    from public.companies company
    where company.id = p_company_id
      and company.status = 'active'
  ) then
    raise exception using message = 'CUSTOMER_PROPERTY_COMPANY_NOT_ACTIVE';
  end if;
  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role is null
    or actor_role not in ('owner', 'dispatcher')
  then
    raise exception using message = 'CUSTOMER_PROPERTY_BACK_OFFICE_REQUIRED';
  end if;

  select key
  into unexpected_key
  from jsonb_object_keys(p_payload) keys(key)
  where key not in ('schemaVersion', 'customer', 'property')
  limit 1;
  if unexpected_key is not null
    or p_payload ->> 'schemaVersion' <> 'storyops-customer-property-create-v1'
    or jsonb_typeof(p_payload -> 'customer') <> 'object'
    or jsonb_typeof(p_payload -> 'property') <> 'object'
  then
    raise exception using message = 'CUSTOMER_PROPERTY_EXACT_PAYLOAD_REQUIRED';
  end if;

  customer_payload := p_payload -> 'customer';
  property_payload := p_payload -> 'property';
  address_payload := property_payload -> 'serviceAddress';

  select key
  into unexpected_key
  from jsonb_object_keys(customer_payload) keys(key)
  where key not in (
    'id', 'kind', 'displayName', 'email', 'phone', 'acquisitionSource'
  )
  limit 1;
  if unexpected_key is not null
    or jsonb_typeof(customer_payload -> 'id') is distinct from 'string'
    or jsonb_typeof(customer_payload -> 'kind') is distinct from 'string'
    or jsonb_typeof(customer_payload -> 'displayName') is distinct from 'string'
    or (
      customer_payload ? 'email'
      and jsonb_typeof(customer_payload -> 'email') not in ('string', 'null')
    )
    or (
      customer_payload ? 'phone'
      and jsonb_typeof(customer_payload -> 'phone') not in ('string', 'null')
    )
    or (
      customer_payload ? 'acquisitionSource'
      and jsonb_typeof(customer_payload -> 'acquisitionSource')
        not in ('string', 'null')
    )
  then
    raise exception using message = 'CUSTOMER_PROPERTY_CUSTOMER_FIELDS_INVALID';
  end if;
  select key
  into unexpected_key
  from jsonb_object_keys(property_payload) keys(key)
  where key not in (
    'id', 'name', 'propertyType', 'serviceAddress', 'knownHazards'
  )
  limit 1;
  if unexpected_key is not null
    or jsonb_typeof(property_payload -> 'id') is distinct from 'string'
    or jsonb_typeof(property_payload -> 'name') is distinct from 'string'
    or jsonb_typeof(property_payload -> 'propertyType')
      is distinct from 'string'
    or jsonb_typeof(address_payload) is distinct from 'object'
    or jsonb_typeof(coalesce(property_payload -> 'knownHazards', '[]'::jsonb))
      <> 'array'
  then
    raise exception using message = 'CUSTOMER_PROPERTY_PROPERTY_FIELDS_INVALID';
  end if;
  select key
  into unexpected_key
  from jsonb_object_keys(address_payload) keys(key)
  where key not in ('line1', 'line2', 'city', 'region', 'postalCode', 'country')
  limit 1;
  if unexpected_key is not null
    or jsonb_typeof(address_payload -> 'line1') is distinct from 'string'
    or jsonb_typeof(address_payload -> 'city') is distinct from 'string'
    or jsonb_typeof(address_payload -> 'region') is distinct from 'string'
    or jsonb_typeof(address_payload -> 'postalCode') is distinct from 'string'
    or jsonb_typeof(address_payload -> 'country') is distinct from 'string'
    or (
      address_payload ? 'line2'
      and jsonb_typeof(address_payload -> 'line2') not in ('string', 'null')
    )
  then
    raise exception using message = 'CUSTOMER_PROPERTY_ADDRESS_FIELDS_INVALID';
  end if;

  if coalesce(customer_payload ->> 'id', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(property_payload ->> 'id', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or customer_payload ->> 'kind' not in ('individual', 'business')
    or property_payload ->> 'propertyType'
      not in ('single_family', 'multi_family', 'commercial', 'other')
    or char_length(btrim(coalesce(customer_payload ->> 'displayName', '')))
      not between 2 and 200
    or char_length(btrim(coalesce(property_payload ->> 'name', '')))
      not between 2 and 200
    or char_length(btrim(coalesce(address_payload ->> 'line1', '')))
      not between 5 and 240
    or char_length(btrim(coalesce(address_payload ->> 'city', '')))
      not between 2 and 120
    or char_length(btrim(coalesce(address_payload ->> 'region', '')))
      not between 2 and 80
    or char_length(btrim(coalesce(address_payload ->> 'postalCode', '')))
      not between 3 and 20
    or char_length(btrim(coalesce(address_payload ->> 'country', '')))
      not between 2 and 2
    or char_length(coalesce(customer_payload ->> 'email', '')) > 320
    or char_length(coalesce(customer_payload ->> 'phone', '')) > 40
    or char_length(coalesce(customer_payload ->> 'acquisitionSource', '')) > 120
    or jsonb_array_length(
      coalesce(property_payload -> 'knownHazards', '[]'::jsonb)
    ) > 20
    or exists (
      select 1
      from jsonb_array_elements(
        coalesce(property_payload -> 'knownHazards', '[]'::jsonb)
      ) hazard
      where jsonb_typeof(hazard) <> 'string'
        or char_length(btrim(hazard #>> '{}')) not between 1 and 200
    )
  then
    raise exception using message = 'CUSTOMER_PROPERTY_FACTS_INVALID';
  end if;
  if nullif(btrim(customer_payload ->> 'email'), '') is not null
    and btrim(customer_payload ->> 'email')
      !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  then
    raise exception using message = 'CUSTOMER_PROPERTY_EMAIL_INVALID';
  end if;

  effective_request_hash := public.storyops_json_sha256(p_payload);
  if effective_request_hash <> p_request_hash then
    raise exception using message = 'CUSTOMER_PROPERTY_REQUEST_HASH_MISMATCH';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'customer-property-create-v1',
    p_operation_id::text,
    effective_request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys idempotency
    where idempotency.company_id = p_company_id
      and idempotency.scope = 'customer-property-create-v1'
      and idempotency.key = p_operation_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception using message = 'CUSTOMER_PROPERTY_IDEMPOTENCY_CONFLICT';
    elsif reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception using message = 'CUSTOMER_PROPERTY_OPERATION_IN_PROGRESS';
  end if;

  customer_id_value := (customer_payload ->> 'id')::uuid;
  property_id_value := (property_payload ->> 'id')::uuid;
  customer_command_id := (
    substr(
      encode(
        extensions.digest(
          p_operation_id::text || ':customer',
          'sha256'
        ),
        'hex'
      ),
      1,
      32
    )
  )::uuid;
  property_command_id := (
    substr(
      encode(
        extensions.digest(
          p_operation_id::text || ':property',
          'sha256'
        ),
        'hex'
      ),
      1,
      32
    )
  )::uuid;

  customer_payload := jsonb_build_object(
    'entityId', customer_id_value,
    'kind', customer_payload ->> 'kind',
    'displayName', btrim(customer_payload ->> 'displayName'),
    'email', nullif(btrim(customer_payload ->> 'email'), ''),
    'phone', nullif(btrim(customer_payload ->> 'phone'), ''),
    'acquisitionSource',
      coalesce(nullif(btrim(customer_payload ->> 'acquisitionSource'), ''), 'manual')
  );
  property_payload := jsonb_build_object(
    'entityId', property_id_value,
    'customerId', customer_id_value,
    'name', btrim(property_payload ->> 'name'),
    'propertyType', property_payload ->> 'propertyType',
    'serviceAddress', jsonb_strip_nulls(jsonb_build_object(
      'line1', btrim(address_payload ->> 'line1'),
      'line2', nullif(btrim(address_payload ->> 'line2'), ''),
      'city', btrim(address_payload ->> 'city'),
      'region', btrim(address_payload ->> 'region'),
      'postalCode', btrim(address_payload ->> 'postalCode'),
      'country', upper(btrim(address_payload ->> 'country'))
    )),
    'knownHazards', coalesce(property_payload -> 'knownHazards', '[]'::jsonb)
  );

  customer_command_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'commandType', 'customer.create',
        'expectedVersion', 0,
        'payload', customer_payload
      )::text,
      'sha256'
    ),
    'hex'
  );
  property_command_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'commandType', 'property.create',
        'expectedVersion', 0,
        'payload', property_payload
      )::text,
      'sha256'
    ),
    'hex'
  );

  -- Both commands execute in this RPC transaction. If either insert fails,
  -- PostgreSQL rolls back both records and every idempotency reservation.
  customer_result := public.execute_storyops_command(
    p_company_id,
    customer_command_id,
    'customer.create',
    0,
    customer_payload,
    customer_command_hash
  );
  property_result := public.execute_storyops_command(
    p_company_id,
    property_command_id,
    'property.create',
    0,
    property_payload,
    property_command_hash
  );
  if customer_result ->> 'entityId' <> customer_id_value::text
    or property_result ->> 'entityId' <> property_id_value::text
  then
    raise exception using message = 'CUSTOMER_PROPERTY_NESTED_RECEIPT_MISMATCH';
  end if;

  result := jsonb_build_object(
    'schemaVersion', 'storyops-customer-property-receipt-v1',
    'operationId', p_operation_id,
    'customerId', customer_id_value,
    'propertyId', property_id_value,
    'customerVersion', (customer_result ->> 'version')::integer,
    'propertyVersion', (property_result ->> 'version')::integer,
    'requestHash', effective_request_hash,
    'replayed', false,
    'serverTime', now()
  );

  insert into public.audit_events(
    company_id, actor_type, actor_id, action, entity_type, entity_id,
    after_data, request_id
  )
  values (
    p_company_id,
    'user',
    actor_user_id::text,
    'customer_property.created_atomically',
    'properties',
    property_id_value,
    jsonb_build_object(
      'customerId', customer_id_value,
      'propertyId', property_id_value,
      'requestHash', effective_request_hash,
      'geocodeStatus', 'review_required'
    ),
    p_operation_id::text
  );

  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = reservation_id;
  return result;
exception
  when invalid_text_representation then
    raise exception using message = 'CUSTOMER_PROPERTY_IDENTIFIER_INVALID';
end;
$$;

revoke all on function public.create_storyops_customer_property(
  uuid, uuid, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_storyops_customer_property(
  uuid, uuid, jsonb, text
) to authenticated;

comment on function public.create_storyops_customer_property(
  uuid, uuid, jsonb, text
) is
  'Creates one customer and its first service property atomically with full-request idempotency; coordinates remain unset pending reviewed live geocoding.';
