\set ON_ERROR_STOP on

begin;

create temporary table acceptance_boundary_state (
  key text primary key,
  value jsonb not null
);
grant select, insert, update on table acceptance_boundary_state to authenticated;

create function pg_temp.accept_quote(
  p_command_id uuid,
  p_customer_id uuid,
  p_quote_id uuid,
  p_quote_version integer,
  p_signer_name text,
  p_acknowledged boolean,
  p_terms_version text,
  p_total text
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public, extensions
as $$
declare
  canonical_request text;
  request_hash text;
begin
  canonical_request := jsonb_build_object(
    'action', 'quote.accept',
    'payload', jsonb_build_object(
      'acknowledged', p_acknowledged,
      'customerId', p_customer_id,
      'quoteId', p_quote_id,
      'quoteVersion', p_quote_version,
      'signerName', btrim(coalesce(p_signer_name, '')),
      'termsVersion', p_terms_version,
      'total', p_total
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  return public.accept_customer_quote(
    '10000000-0000-4000-8000-000000000001',
    p_customer_id,
    p_command_id,
    p_quote_id,
    p_quote_version,
    p_signer_name,
    p_acknowledged,
    p_terms_version,
    p_total,
    canonical_request,
    request_hash
  );
end;
$$;

insert into public.quotes(
  id, company_id, quote_number, estimate_id, customer_id, property_id, status,
  valid_until, terms_version, terms_snapshot, total, deposit_required,
  sent_at, portal_published_at
)
values
  (
    '34000000-0000-4000-8000-000000000521',
    '10000000-0000-4000-8000-000000000001',
    'Q-ACCEPTANCE-ELIGIBLE',
    '10000000-0000-4000-8000-000000000501',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'sent',
    current_date + 14,
    'terms-v1',
    'Exact affirmative-acceptance integration fixture.',
    528.00,
    132.00,
    now(),
    now()
  ),
  (
    '34000000-0000-4000-8000-000000000522',
    '10000000-0000-4000-8000-000000000001',
    'Q-ACCEPTANCE-EXPIRED',
    '10000000-0000-4000-8000-000000000501',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'sent',
    current_date - 1,
    'terms-v1',
    'Expired affirmative-acceptance integration fixture.',
    528.00,
    132.00,
    now() - interval '15 days',
    now() - interval '15 days'
  );

\echo '1/12 function and table privileges expose only the two typed authenticated RPCs'
do $$
begin
  if not has_function_privilege(
      'authenticated',
      'public.accept_customer_quote(uuid,uuid,uuid,uuid,integer,text,boolean,text,text,text,text)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.accept_customer_quote(uuid,uuid,uuid,uuid,integer,text,boolean,text,text,text,text)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'public.accept_customer_quote(uuid,uuid,uuid,uuid,integer,text,boolean,text,text,text,text)',
      'execute'
    )
    or not has_function_privilege(
      'authenticated',
      'public.get_storyops_audit_feed(uuid,timestamp with time zone,uuid,integer)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.get_storyops_audit_feed(uuid,timestamp with time zone,uuid,integer)',
      'execute'
    )
    or has_function_privilege(
      'service_role',
      'public.get_storyops_audit_feed(uuid,timestamp with time zone,uuid,integer)',
      'execute'
    )
    or has_table_privilege('authenticated', 'public.customer_quote_acceptances', 'select')
    or has_table_privilege('authenticated', 'public.customer_quote_acceptances', 'insert')
    or has_table_privilege('authenticated', 'public.customer_quote_acceptances', 'update')
    or has_table_privilege('authenticated', 'public.customer_quote_acceptances', 'delete')
    or has_table_privilege('service_role', 'public.customer_quote_acceptances', 'select')
    or has_table_privilege('service_role', 'public.customer_quote_acceptances', 'insert')
    or has_table_privilege('service_role', 'public.customer_quote_acceptances', 'update')
    or has_table_privilege('service_role', 'public.customer_quote_acceptances', 'delete')
    or has_table_privilege('authenticated', 'public.audit_events', 'select')
    or has_table_privilege('authenticated', 'public.audit_events', 'insert')
    or has_table_privilege('authenticated', 'public.audit_events', 'update')
    or has_table_privilege('authenticated', 'public.audit_events', 'delete')
    or has_table_privilege('service_role', 'public.audit_events', 'select')
    or has_table_privilege('service_role', 'public.audit_events', 'insert')
    or has_table_privilege('service_role', 'public.audit_events', 'update')
    or has_table_privilege('service_role', 'public.audit_events', 'delete')
  then
    raise exception 'Acceptance or redacted-audit privileges are broader than intended';
  end if;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

\echo '2/12 the legacy generic quote.accept path cannot infer affirmative evidence'
do $$
declare
  payload jsonb := jsonb_build_object(
    'entityId', '34000000-0000-4000-8000-000000000521'::uuid,
    'signerName', 'Casey Morgan'
  );
  request_hash text;
  blocked boolean := false;
begin
  request_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'commandType', 'quote.accept',
        'expectedVersion', 1,
        'payload', payload
      )::text,
      'sha256'
    ),
    'hex'
  );
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '34000000-0000-4000-8000-000000000001',
      'quote.accept',
      1,
      payload,
      request_hash
    );
  exception
    when others then
      blocked := position('AFFIRMATIVE_QUOTE_ACCEPTANCE_REQUIRED' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Generic quote.accept bypassed the affirmative evidence trigger';
  end if;
end;
$$;
reset role;
do $$
begin
  if (
    select status
    from public.quotes
    where id = '34000000-0000-4000-8000-000000000521'
  ) <> 'sent' then
    raise exception 'Blocked generic quote.accept changed the quote';
  end if;
end;
$$;
set local role authenticated;

\echo '3/12 signer, affirmative acknowledgment, terms syntax, money, and version are explicit'
do $$
declare
  blocked_signer boolean := false;
  blocked_control boolean := false;
  blocked_ack boolean := false;
  blocked_terms boolean := false;
  blocked_money boolean := false;
  blocked_version boolean := false;
begin
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, ' ', true, 'terms-v1', '528.00'
    );
  exception when others then
    blocked_signer := position('QUOTE_ACCEPTANCE_INVALID' in sqlerrm) > 0;
  end;
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, E'Casey\nMorgan', true, 'terms-v1', '528.00'
    );
  exception when others then
    blocked_control := position('QUOTE_ACCEPTANCE_INVALID' in sqlerrm) > 0;
  end;
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000004',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, 'Casey Morgan', false, 'terms-v1', '528.00'
    );
  exception when others then
    blocked_ack := position('QUOTE_ACCEPTANCE_INVALID' in sqlerrm) > 0;
  end;
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000005',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, 'Casey Morgan', true, ' terms-v1', '528.00'
    );
  exception when others then
    blocked_terms := position('QUOTE_ACCEPTANCE_INVALID' in sqlerrm) > 0;
  end;
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, 'Casey Morgan', true, 'terms-v1', '0528.00'
    );
  exception when others then
    blocked_money := position('QUOTE_ACCEPTANCE_INVALID' in sqlerrm) > 0;
  end;
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000007',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      null, 'Casey Morgan', true, 'terms-v1', '528.00'
    );
  exception when others then
    blocked_version := position('QUOTE_ACCEPTANCE_INVALID' in sqlerrm) > 0;
  end;
  if not blocked_signer
    or not blocked_control
    or not blocked_ack
    or not blocked_terms
    or not blocked_money
    or not blocked_version
  then
    raise exception 'One explicit acceptance input was not fail-closed';
  end if;
end;
$$;

\echo '4/12 canonical JSON and lowercase SHA-256 bind every submitted field'
do $$
declare
  canonical_request text;
  request_hash text;
  blocked_payload boolean := false;
  blocked_hash boolean := false;
begin
  canonical_request := jsonb_build_object(
    'action', 'quote.accept',
    'payload', jsonb_build_object(
      'acknowledged', true,
      'customerId', '10000000-0000-4000-8000-000000000201'::uuid,
      'quoteId', '34000000-0000-4000-8000-000000000521'::uuid,
      'quoteVersion', 1,
      'signerName', 'Another Signer',
      'termsVersion', 'terms-v1',
      'total', '528.00'
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  begin
    perform public.accept_customer_quote(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000008',
      '34000000-0000-4000-8000-000000000521',
      1,
      'Casey Morgan',
      true,
      'terms-v1',
      '528.00',
      canonical_request,
      request_hash
    );
  exception when others then
    blocked_payload := position('QUOTE_ACCEPTANCE_HASH_MISMATCH' in sqlerrm) > 0;
  end;
  canonical_request := jsonb_build_object(
    'action', 'quote.accept',
    'payload', jsonb_build_object(
      'acknowledged', true,
      'customerId', '10000000-0000-4000-8000-000000000201'::uuid,
      'quoteId', '34000000-0000-4000-8000-000000000521'::uuid,
      'quoteVersion', 1,
      'signerName', 'Casey Morgan',
      'termsVersion', 'terms-v1',
      'total', '528.00'
    )
  )::text;
  begin
    perform public.accept_customer_quote(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000009',
      '34000000-0000-4000-8000-000000000521',
      1,
      'Casey Morgan',
      true,
      'terms-v1',
      '528.00',
      canonical_request,
      repeat('0', 64)
    );
  exception when others then
    blocked_hash := position('QUOTE_ACCEPTANCE_HASH_MISMATCH' in sqlerrm) > 0;
  end;
  if not blocked_payload or not blocked_hash then
    raise exception 'Acceptance canonical request or request hash was not exact';
  end if;
end;
$$;

\echo '5/12 quote version, expiry, published terms, total, and customer scope are authoritative'
do $$
declare
  blocked_version boolean := false;
  blocked_expiry boolean := false;
  blocked_terms boolean := false;
  blocked_total boolean := false;
  blocked_customer boolean := false;
begin
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000010',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      2, 'Casey Morgan', true, 'terms-v1', '528.00'
    );
  exception when others then
    blocked_version := position('QUOTE_ACCEPTANCE_NOT_ELIGIBLE' in sqlerrm) > 0;
  end;
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000011',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000522',
      1, 'Casey Morgan', true, 'terms-v1', '528.00'
    );
  exception when others then
    blocked_expiry := position('QUOTE_ACCEPTANCE_NOT_ELIGIBLE' in sqlerrm) > 0;
  end;
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000012',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, 'Casey Morgan', true, 'terms-v2', '528.00'
    );
  exception when others then
    blocked_terms := position('QUOTE_ACCEPTANCE_CONTEXT_MISMATCH' in sqlerrm) > 0;
  end;
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000013',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, 'Casey Morgan', true, 'terms-v1', '527.99'
    );
  exception when others then
    blocked_total := position('QUOTE_ACCEPTANCE_CONTEXT_MISMATCH' in sqlerrm) > 0;
  end;
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000014',
      '34000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, 'Casey Morgan', true, 'terms-v1', '528.00'
    );
  exception when others then
    blocked_customer := position('CUSTOMER_PORTAL_SCOPE_DENIED' in sqlerrm) > 0;
  end;
  if not blocked_version
    or not blocked_expiry
    or not blocked_terms
    or not blocked_total
    or not blocked_customer
  then
    raise exception 'One authoritative quote/customer context check was bypassed';
  end if;
end;
$$;

\echo '6/12 a blocked customer cannot transact through a still-present portal mapping'
reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
update public.customers
set lifecycle = 'blocked'
where id = '10000000-0000-4000-8000-000000000201';
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
do $$
declare
  blocked boolean := false;
begin
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000015',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, 'Casey Morgan', true, 'terms-v1', '528.00'
    );
  exception when others then
    blocked := position('QUOTE_ACCEPTANCE_NOT_ELIGIBLE' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Blocked customer remained acceptance eligible';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
update public.customers
set lifecycle = 'active'
where id = '10000000-0000-4000-8000-000000000201';
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

\echo '7/12 exact acceptance is durable, versioned, and returns no invented context'
do $$
declare
  receipt jsonb;
begin
  receipt := pg_temp.accept_quote(
    '34000000-0000-4000-8000-000000000016',
    '10000000-0000-4000-8000-000000000201',
    '34000000-0000-4000-8000-000000000521',
    1, '  Casey Morgan  ', true, 'terms-v1', '528.00'
  );
  insert into acceptance_boundary_state(key, value)
  values ('receipt', receipt);
end;
$$;
reset role;
do $$
declare
  receipt jsonb;
  acceptance public.customer_quote_acceptances%rowtype;
  quote_row public.quotes%rowtype;
begin
  select value into receipt
  from acceptance_boundary_state
  where key = 'receipt';
  select * into acceptance
  from public.customer_quote_acceptances
  where company_id = '10000000-0000-4000-8000-000000000001'
    and command_id = '34000000-0000-4000-8000-000000000016';
  select * into quote_row
  from public.quotes
  where id = '34000000-0000-4000-8000-000000000521';
  if receipt ->> 'schemaVersion' <> 'storyops-customer-quote-acceptance-v1'
    or receipt ->> 'quoteId' <> quote_row.id::text
    or (receipt ->> 'expectedQuoteVersion')::integer <> acceptance.quote_version
    or (receipt ->> 'quoteVersion')::integer <> quote_row.version
    or receipt ->> 'signerName' <> 'Casey Morgan'
    or receipt ->> 'termsVersion' <> quote_row.terms_version
    or receipt ->> 'total' <> quote_row.total::text
    or not (receipt ->> 'acknowledged')::boolean
    or (receipt ->> 'replayed')::boolean
    or (receipt ->> 'acceptedAt')::timestamptz <> acceptance.accepted_at
    or receipt ->> 'acceptanceContextHash' <> acceptance.acceptance_context_hash
    or acceptance.customer_id <> quote_row.customer_id
    or acceptance.quote_version <> 1
    or acceptance.accepted_total <> quote_row.total
    or acceptance.signer_name <> quote_row.accepted_by_name
    or acceptance.actor_user_id <> quote_row.accepted_by_user_id
    or acceptance.accepted_at <> quote_row.accepted_at
    or acceptance.acceptance_context_hash <> quote_row.acceptance_context_hash
    or quote_row.status <> 'accepted'
    or quote_row.version <> 2
  then
    raise exception 'Durable acceptance receipt/evidence disagreed: %, %, %',
      receipt, to_jsonb(acceptance), to_jsonb(quote_row);
  end if;
end;
$$;
set local role authenticated;

\echo '8/12 identical replay is stable; changed reuse and a second acceptance lose deterministically'
do $$
declare
  replay jsonb;
  conflict_blocked boolean := false;
  second_blocked boolean := false;
begin
  replay := pg_temp.accept_quote(
    '34000000-0000-4000-8000-000000000016',
    '10000000-0000-4000-8000-000000000201',
    '34000000-0000-4000-8000-000000000521',
    1, 'Casey Morgan', true, 'terms-v1', '528.00'
  );
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000016',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, 'Different Signer', true, 'terms-v1', '528.00'
    );
  exception when others then
    conflict_blocked :=
      position('QUOTE_ACCEPTANCE_IDEMPOTENCY_CONFLICT' in sqlerrm) > 0;
  end;
  begin
    perform pg_temp.accept_quote(
      '34000000-0000-4000-8000-000000000017',
      '10000000-0000-4000-8000-000000000201',
      '34000000-0000-4000-8000-000000000521',
      1, 'Casey Morgan', true, 'terms-v1', '528.00'
    );
  exception when others then
    second_blocked := position('QUOTE_ACCEPTANCE_NOT_ELIGIBLE' in sqlerrm) > 0;
  end;
  if not (replay ->> 'replayed')::boolean
    or replay ->> 'commandId' <> '34000000-0000-4000-8000-000000000016'
    or not conflict_blocked
    or not second_blocked
  then
    raise exception 'Replay/conflict/single-winner contract failed: %', replay;
  end if;
end;
$$;

\echo '9/12 row locking and uniqueness provide the concurrent single-winner boundary'
reset role;
do $$
declare
  function_definition text;
begin
  select pg_get_functiondef(
    'public.accept_customer_quote(uuid,uuid,uuid,uuid,integer,text,boolean,text,text,text,text)'::regprocedure
  )
  into function_definition;
  if position('for update' in lower(function_definition)) = 0
    or position(
      'on conflict (company_id, scope, key) do nothing'
      in lower(function_definition)
    ) = 0
    or not exists (
      select 1
      from pg_constraint constraint_record
      where constraint_record.conrelid =
        'public.customer_quote_acceptances'::regclass
        and constraint_record.contype = 'u'
        and pg_get_constraintdef(constraint_record.oid)
          = 'UNIQUE (company_id, quote_id)'
    )
    or (
      select count(*)
      from public.customer_quote_acceptances
      where company_id = '10000000-0000-4000-8000-000000000001'
        and quote_id = '34000000-0000-4000-8000-000000000521'
    ) <> 1
  then
    raise exception 'Concurrent acceptance lock or uniqueness boundary is missing';
  end if;
end;
$$;

\echo '10/12 acceptance evidence and the resulting accepted quote are immutable'
do $$
declare
  update_blocked boolean := false;
  delete_blocked boolean := false;
  quote_blocked boolean := false;
begin
  begin
    update public.customer_quote_acceptances
    set signer_name = 'Mutated Signer'
    where company_id = '10000000-0000-4000-8000-000000000001'
      and command_id = '34000000-0000-4000-8000-000000000016';
  exception when others then
    update_blocked := position('is append-only' in sqlerrm) > 0;
  end;
  begin
    delete from public.customer_quote_acceptances
    where company_id = '10000000-0000-4000-8000-000000000001'
      and command_id = '34000000-0000-4000-8000-000000000016';
  exception when others then
    delete_blocked := position('is append-only' in sqlerrm) > 0;
  end;
  begin
    update public.quotes
    set terms_snapshot = 'Mutated terms'
    where id = '34000000-0000-4000-8000-000000000521';
  exception when others then
    quote_blocked := position('ACCEPTED_QUOTE_IMMUTABLE' in sqlerrm) > 0;
  end;
  if not update_blocked or not delete_blocked or not quote_blocked then
    raise exception 'Acceptance or accepted quote evidence was mutable';
  end if;
end;
$$;

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '34000000-0000-4000-8000-000000000101',
    'authenticated',
    'authenticated',
    'audit-owner-b@example.test',
    extensions.crypt('LocalOnly1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '34000000-0000-4000-8000-000000000102',
    'authenticated',
    'authenticated',
    'audit-owner-b-retained@example.test',
    extensions.crypt('LocalOnly1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now(),
    '',
    '',
    '',
    ''
  );
insert into public.companies(id, name, timezone, status)
values (
  '34000000-0000-4000-8000-000000000001',
  'Audit Boundary Company B',
  'America/Chicago',
  'active'
);
insert into public.company_memberships(id, company_id, user_id, role, active)
values
  (
    '34000000-0000-4000-8000-000000000111',
    '34000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000101',
    'owner',
    true
  ),
  (
    '34000000-0000-4000-8000-000000000112',
    '34000000-0000-4000-8000-000000000001',
    '34000000-0000-4000-8000-000000000102',
    'owner',
    true
  );
insert into public.audit_events(
  id, company_id, occurred_at, actor_type, actor_id, action, entity_type,
  entity_id, before_data, after_data, request_id, trace_id, retain_until
)
values
  (
    '34000000-0000-4000-8000-000000000701',
    '34000000-0000-4000-8000-000000000001',
    now() - interval '3 seconds',
    'user',
    'sensitive.actor@example.test',
    'audit.boundary.one',
    'boundary_fixture',
    '34000000-0000-4000-8000-000000000801',
    '{"secret":"before-value-must-not-project"}',
    '{"secret":"after-value-must-not-project"}',
    'unsafe request id with spaces and sensitive.actor@example.test',
    'unsafe trace id with spaces and sensitive.actor@example.test',
    now() + interval '7 years'
  ),
  (
    '34000000-0000-4000-8000-000000000702',
    '34000000-0000-4000-8000-000000000001',
    now() - interval '2 seconds',
    'system',
    'system',
    'audit.boundary.two',
    'boundary_fixture',
    '34000000-0000-4000-8000-000000000802',
    null,
    '{"status":"safe"}',
    '34000000-0000-4000-8000-000000000902',
    'trace.audit-boundary-2',
    now() + interval '7 years'
  ),
  (
    '34000000-0000-4000-8000-000000000703',
    '34000000-0000-4000-8000-000000000001',
    now() - interval '1 second',
    'provider',
    'provider-account-secret',
    'audit.boundary.three',
    'boundary_fixture',
    '34000000-0000-4000-8000-000000000803',
    null,
    null,
    null,
    null,
    now() + interval '7 years'
  );
insert into acceptance_boundary_state(key, value)
select
  'company-a-cursor',
  jsonb_build_object('occurredAt', event.occurred_at, 'id', event.id)
from public.audit_events event
where event.company_id = '10000000-0000-4000-8000-000000000001'
order by event.occurred_at desc, event.id desc
limit 1;

\echo '11/12 audit feed is owner-only, company-scoped, bounded, redacted, and cursor-exact'
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000102","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  dispatcher_blocked boolean := false;
begin
  begin
    perform public.get_storyops_audit_feed(
      '10000000-0000-4000-8000-000000000001',
      null,
      null,
      10
    );
  exception when others then
    dispatcher_blocked := position('AUDIT_FEED_OWNER_REQUIRED' in sqlerrm) > 0;
  end;
  if not dispatcher_blocked then
    raise exception 'Dispatcher reached the owner-only audit feed';
  end if;
end;
$$;

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
do $$
declare
  cross_company_blocked boolean := false;
  raw_table_blocked boolean := false;
begin
  begin
    perform public.get_storyops_audit_feed(
      '34000000-0000-4000-8000-000000000001',
      null,
      null,
      10
    );
  exception when others then
    cross_company_blocked := position('AUDIT_FEED_OWNER_REQUIRED' in sqlerrm) > 0;
  end;
  begin
    perform count(*) from public.audit_events;
  exception when insufficient_privilege then
    raw_table_blocked := true;
  end;
  if not cross_company_blocked or not raw_table_blocked then
    raise exception 'Cross-company or raw audit access remained available';
  end if;
end;
$$;

select set_config(
  'request.jwt.claims',
  '{"sub":"34000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '34000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  first_page jsonb;
  second_page jsonb;
  cursor_time timestamptz;
  cursor_id uuid;
  mixed_cursor_blocked boolean := false;
  cross_company_cursor_blocked boolean := false;
  lower_bound_blocked boolean := false;
  upper_bound_blocked boolean := false;
  company_a_cursor jsonb;
begin
  first_page := public.get_storyops_audit_feed(
    '34000000-0000-4000-8000-000000000001',
    null,
    null,
    2
  );
  cursor_time := (first_page #>> '{nextCursor,occurredAt}')::timestamptz;
  cursor_id := (first_page #>> '{nextCursor,id}')::uuid;
  second_page := public.get_storyops_audit_feed(
    '34000000-0000-4000-8000-000000000001',
    cursor_time,
    cursor_id,
    2
  );
  begin
    perform public.get_storyops_audit_feed(
      '34000000-0000-4000-8000-000000000001',
      cursor_time,
      null,
      2
    );
  exception when others then
    mixed_cursor_blocked := position('AUDIT_FEED_CURSOR_INVALID' in sqlerrm) > 0;
  end;
  begin
    select value into company_a_cursor
    from acceptance_boundary_state
    where key = 'company-a-cursor';
    perform public.get_storyops_audit_feed(
      '34000000-0000-4000-8000-000000000001',
      (company_a_cursor ->> 'occurredAt')::timestamptz,
      (company_a_cursor ->> 'id')::uuid,
      2
    );
  exception when others then
    cross_company_cursor_blocked :=
      position('AUDIT_FEED_CURSOR_INVALID' in sqlerrm) > 0;
  end;
  begin
    perform public.get_storyops_audit_feed(
      '34000000-0000-4000-8000-000000000001', null, null, 0
    );
  exception when others then
    lower_bound_blocked := position('AUDIT_FEED_CURSOR_INVALID' in sqlerrm) > 0;
  end;
  begin
    perform public.get_storyops_audit_feed(
      '34000000-0000-4000-8000-000000000001', null, null, 101
    );
  exception when others then
    upper_bound_blocked := position('AUDIT_FEED_CURSOR_INVALID' in sqlerrm) > 0;
  end;
  if first_page ->> 'schemaVersion' <> 'storyops-audit-feed-v1'
    or first_page ->> 'companyId' <> '34000000-0000-4000-8000-000000000001'
    or not (first_page ->> 'redacted')::boolean
    or (first_page ->> 'pageLimit')::integer <> 2
    or jsonb_array_length(first_page -> 'events') <> 2
    or not (first_page ->> 'hasMore')::boolean
    or first_page -> 'nextCursor' is null
    or exists (
      select 1
      from jsonb_array_elements(first_page -> 'events') first_event
      join jsonb_array_elements(second_page -> 'events') second_event
        on second_event ->> 'id' = first_event ->> 'id'
    )
    or (first_page::text || second_page::text)
      like '%sensitive.actor@example.test%'
    or (first_page::text || second_page::text)
      like '%before-value-must-not-project%'
    or (first_page::text || second_page::text)
      like '%after-value-must-not-project%'
    or exists (
      select 1
      from jsonb_array_elements(first_page -> 'events') event
      where event ? 'beforeData'
        or event ? 'afterData'
        or event ? 'actorId'
    )
    or not mixed_cursor_blocked
    or not cross_company_cursor_blocked
    or not lower_bound_blocked
    or not upper_bound_blocked
  then
    raise exception 'Redacted audit pagination contract failed: %, %',
      first_page, second_page;
  end if;
end;
$$;

\echo '12/12 offboarded owners fail closed'
reset role;
update public.company_memberships
set active = false
where company_id = '34000000-0000-4000-8000-000000000001'
  and user_id = '34000000-0000-4000-8000-000000000101';
set local role authenticated;
do $$
declare
  offboarded_blocked boolean := false;
begin
  begin
    perform public.get_storyops_audit_feed(
      '34000000-0000-4000-8000-000000000001', null, null, 10
    );
  exception when others then
    offboarded_blocked := position('AUDIT_FEED_OWNER_REQUIRED' in sqlerrm) > 0;
  end;
  if not offboarded_blocked then
    raise exception 'Audit offboarding did not fail closed';
  end if;
end;
$$;

rollback;

\echo 'audit and quote acceptance boundary integration: pass'
