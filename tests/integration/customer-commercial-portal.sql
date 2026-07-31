\set ON_ERROR_STOP on

begin;

create temporary table commercial_baseline as
select
  (select count(*) from public.communication_messages) as message_count,
  (select count(*) from public.webhook_events) as webhook_count;

insert into public.quotes(
  id, company_id, quote_number, estimate_id, customer_id, property_id, status,
  valid_until, terms_version, terms_snapshot, total, deposit_required
)
values (
  '32000000-0000-4000-8000-000000000521',
  '10000000-0000-4000-8000-000000000001',
  'Q-COMMERCIAL-1',
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000211',
  'sent',
  current_date + 14,
  'terms-v1',
  'Exact published portal terms fixture.',
  528.00,
  132.00
);

insert into public.quotes(
  id, company_id, quote_number, estimate_id, customer_id, property_id, status,
  valid_until, terms_version, terms_snapshot, total, deposit_required
)
values (
  '32000000-0000-4000-8000-000000000520',
  '10000000-0000-4000-8000-000000000001',
  'Q-NEVER-PUBLISHED-EXPIRED',
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000211',
  'expired',
  current_date - 1,
  'terms-v1',
  'Never-published expired quote fixture.',
  528.00,
  132.00
);

\echo '1/14 portal publication is durable and does not assert provider delivery'
do $$
declare
  quote_row public.quotes%rowtype;
begin
  select * into quote_row
  from public.quotes
  where id = '32000000-0000-4000-8000-000000000521';
  if quote_row.portal_published_at is null
    or quote_row.status <> 'sent'
    or (select count(*) from public.communication_messages)
      <> (select message_count from commercial_baseline)
    or (select count(*) from public.webhook_events)
      <> (select webhook_count from commercial_baseline)
  then
    raise exception 'Portal publication fabricated or omitted delivery truth';
  end if;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

\echo '2/14 customer projection is bounded and excludes every internal draft invoice'
do $$
declare
  portal jsonb;
  workspace jsonb;
begin
  portal := public.get_customer_portal_state(
    '10000000-0000-4000-8000-000000000001'
  );
  workspace := public.get_storyops_workspace(
    '10000000-0000-4000-8000-000000000001'
  );
  if portal ->> 'schemaVersion' <> 'storyops-customer-portal-state-v2'
    or portal #>> '{customers,0,commercial,quote,id}'
      <> '32000000-0000-4000-8000-000000000521'
    or portal #>> '{customers,0,commercial,quote,deliveryStatus}'
      <> 'not_asserted'
    or jsonb_array_length(portal #> '{customers,0,commercial,addOnOptions}') < 1
    or exists (
      select 1
      from jsonb_array_elements(workspace -> 'quotes') quote
      where quote ->> 'id' = '32000000-0000-4000-8000-000000000520'
    )
    or exists (
      select 1
      from jsonb_array_elements(workspace -> 'invoices') invoice
      where invoice ->> 'status' in ('draft', 'void', 'uncollectible')
    )
    or exists (
      select 1
      from jsonb_array_elements(
        portal #> '{customers,0,commercial,invoices}'
      ) invoice
      where invoice ->> 'status' in ('draft', 'void', 'uncollectible')
    )
  then
    raise exception 'Commercial portal projection was unbounded: %', portal;
  end if;
end;
$$;

reset role;
update public.companies
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    );
  exception when others then
    blocked := position('No active company membership' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Paused company remained visible to a customer workspace';
  end if;
end;
$$;
reset role;
update public.companies
set status = 'active'
where id = '10000000-0000-4000-8000-000000000001';
set local role authenticated;

\echo '3/14 quote view is exact, versioned, idempotent, and concurrent-replay compatible'
do $$
declare
  canonical text;
  request_hash text;
  receipt jsonb;
  replay jsonb;
begin
  canonical := jsonb_build_object(
    'action', 'quote.view',
    'payload', jsonb_build_object(
      'addOnCodes', '[]'::jsonb,
      'customerId', '10000000-0000-4000-8000-000000000201'::uuid,
      'notes', '',
      'quoteId', '32000000-0000-4000-8000-000000000521'::uuid,
      'quoteVersion', 1,
      'serviceCodes', '[]'::jsonb
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical, 'UTF8'), 'sha256'),
    'hex'
  );
  receipt := public.execute_customer_quote_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '32000000-0000-4000-8000-000000000001',
    'quote.view',
    '32000000-0000-4000-8000-000000000521',
    1,
    array[]::text[],
    array[]::text[],
    '',
    canonical,
    request_hash
  );
  replay := public.execute_customer_quote_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '32000000-0000-4000-8000-000000000001',
    'quote.view',
    '32000000-0000-4000-8000-000000000521',
    1,
    array[]::text[],
    array[]::text[],
    '',
    canonical,
    request_hash
  );
  if receipt ->> 'quoteStatus' <> 'viewed'
    or (receipt ->> 'quoteVersion')::integer <> 2
    or (receipt ->> 'deliveryAsserted')::boolean
    or (receipt ->> 'replayed')::boolean
    or not (replay ->> 'replayed')::boolean
    or replay ->> 'requestHash' <> request_hash
  then
    raise exception 'Quote view/replay receipt was not exact: %, %', receipt, replay;
  end if;
end;
$$;

reset role;
create temporary table quote_financial_before as
select
  quote.total,
  quote.deposit_required,
  quote.terms_version,
  quote.terms_snapshot,
  (
    select jsonb_agg(to_jsonb(line) order by line.sort_order)
    from public.estimate_lines line
    where line.estimate_id = quote.estimate_id
  ) as lines
from public.quotes quote
where quote.id = '32000000-0000-4000-8000-000000000521';
set local role authenticated;

\echo '4/14 change request freezes exact choices and never changes price, lines, terms, or acceptance'
do $$
declare
  canonical text;
  request_hash text;
  receipt jsonb;
begin
  canonical := jsonb_build_object(
    'action', 'quote.change_request',
    'payload', jsonb_build_object(
      'addOnCodes', jsonb_build_array('gutter-cleaning:downspout-flush'),
      'customerId', '10000000-0000-4000-8000-000000000201'::uuid,
      'notes', 'Please add the detached garage apron.',
      'quoteId', '32000000-0000-4000-8000-000000000521'::uuid,
      'quoteVersion', 2,
      'serviceCodes', jsonb_build_array('gutter-cleaning')
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical, 'UTF8'), 'sha256'),
    'hex'
  );
  receipt := public.execute_customer_quote_action(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    '32000000-0000-4000-8000-000000000002',
    'quote.change_request',
    '32000000-0000-4000-8000-000000000521',
    2,
    array['gutter-cleaning'],
    array['gutter-cleaning:downspout-flush'],
    'Please add the detached garage apron.',
    canonical,
    request_hash
  );
  if receipt ->> 'quoteStatus' <> 'change_requested'
    or receipt ->> 'changeRequestId' is null
    or (receipt ->> 'priceChanged')::boolean
    or (receipt ->> 'termsChanged')::boolean
    or (receipt ->> 'accepted')::boolean
  then
    raise exception 'Change request receipt claimed a commercial mutation: %', receipt;
  end if;
end;
$$;

reset role;
do $$
declare
  before_row quote_financial_before%rowtype;
  quote_row public.quotes%rowtype;
  current_lines jsonb;
  request_count integer;
begin
  select * into before_row from quote_financial_before;
  select * into quote_row
  from public.quotes
  where id = '32000000-0000-4000-8000-000000000521';
  select jsonb_agg(to_jsonb(line) order by line.sort_order)
  into current_lines
  from public.estimate_lines line
  where line.estimate_id = quote_row.estimate_id;
  select count(*) into request_count
  from public.customer_quote_change_requests request
  where request.quote_id = quote_row.id
    and request.quote_version = 2
    and request.requested_service_codes = array['gutter-cleaning']
    and request.requested_add_on_codes
      = array['gutter-cleaning:downspout-flush']
    and request.status = 'submitted';
  if quote_row.status <> 'change_requested'
    or quote_row.total <> before_row.total
    or quote_row.deposit_required <> before_row.deposit_required
    or quote_row.terms_version <> before_row.terms_version
    or quote_row.terms_snapshot <> before_row.terms_snapshot
    or current_lines <> before_row.lines
    or request_count <> 1
  then
    raise exception 'Change request mutated the accepted commercial facts';
  end if;
end;
$$;

\echo '5/14 change-requested quote cannot be accepted or declined'
set local role authenticated;
do $$
declare
  payload jsonb := jsonb_build_object(
    'entityId', '32000000-0000-4000-8000-000000000521'::uuid,
    'signerName', 'Casey Morgan'
  );
  request_hash text;
  blocked boolean := false;
begin
  request_hash := encode(extensions.digest(jsonb_build_object(
    'commandType', 'quote.accept',
    'expectedVersion', 3,
    'payload', payload
  )::text, 'sha256'), 'hex');
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000003',
      'quote.accept',
      3,
      payload,
      request_hash
    );
  exception when others then
    blocked := position('stale, expired, or not owned' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Change-requested quote remained accept eligible';
  end if;
end;
$$;

\echo '6/14 customer direct quote and request DML is denied'
do $$
declare
  blocked_quote boolean := false;
  blocked_request boolean := false;
begin
  begin
    update public.quotes
    set status = 'accepted'
    where id = '32000000-0000-4000-8000-000000000521';
  exception when insufficient_privilege then
    blocked_quote := true;
  end;
  begin
    update public.customer_quote_change_requests
    set status = 'cancelled'
    where quote_id = '32000000-0000-4000-8000-000000000521';
  exception when insufficient_privilege then
    blocked_request := true;
  end;
  if not blocked_quote or not blocked_request then
    raise exception 'Customer direct commercial DML was not denied';
  end if;
end;
$$;

\echo '7/14 owner workspace receives the exact durable queue and next action'
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  workspace jsonb;
begin
  workspace := public.get_storyops_workspace(
    '10000000-0000-4000-8000-000000000001'
  );
  if not exists (
    select 1
    from jsonb_array_elements(workspace -> 'customerQuoteChangeRequests') request
    where request ->> 'quoteId' = '32000000-0000-4000-8000-000000000521'
      and (request ->> 'quoteVersion')::integer = 2
      and request ->> 'requestNotes' = 'Please add the detached garage apron.'
      and request ->> 'nextAction' like 'Re-estimate%'
  ) then
    raise exception 'Back-office queue omitted the exact customer request: %', workspace;
  end if;
end;
$$;

\echo '8/14 finite staff resolution requires an exact newer published replacement'
reset role;
insert into public.quotes(
  id, company_id, quote_number, estimate_id, customer_id, property_id, status,
  valid_until, terms_version, terms_snapshot, total, deposit_required, created_at
)
values (
  '32000000-0000-4000-8000-000000000522',
  '10000000-0000-4000-8000-000000000001',
  'Q-COMMERCIAL-2',
  '10000000-0000-4000-8000-000000000501',
  '10000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000211',
  'sent',
  current_date + 14,
  'terms-v1',
  'Exact replacement portal terms fixture.',
  528.00,
  132.00,
  now() + interval '1 second'
);
create temporary table commercial_resolution_fixture(
  request_id uuid primary key
) on commit drop;
insert into commercial_resolution_fixture(request_id)
select id
from public.customer_quote_change_requests
where quote_id = '32000000-0000-4000-8000-000000000521';
grant select on commercial_resolution_fixture to authenticated;
set local role authenticated;
do $$
declare
  request_id uuid;
  canonical text;
  request_hash text;
  receipt jsonb;
begin
  select fixture.request_id into request_id
  from commercial_resolution_fixture fixture;
  canonical := jsonb_build_object(
    'action', 'quote.change_request.resolve',
    'payload', jsonb_build_object(
      'disposition', 'replacement_published',
      'expectedRequestVersion', 1,
      'replacementQuoteId', '32000000-0000-4000-8000-000000000522'::uuid,
      'replacementQuoteVersion', 1,
      'requestId', request_id,
      'resolutionNote', 'Re-estimated from verified evidence and republished.'
    )
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical, 'UTF8'), 'sha256'),
    'hex'
  );
  receipt := public.resolve_customer_quote_change_request(
    '10000000-0000-4000-8000-000000000001',
    '32000000-0000-4000-8000-000000000004',
    request_id,
    1,
    'replacement_published',
    '32000000-0000-4000-8000-000000000522',
    1,
    'Re-estimated from verified evidence and republished.',
    canonical,
    request_hash
  );
  if receipt ->> 'disposition' <> 'replacement_published'
    or receipt ->> 'replacementQuoteId'
      <> '32000000-0000-4000-8000-000000000522'
    or (receipt ->> 'requestVersion')::integer <> 2
  then
    raise exception 'Staff resolution was not bound to the replacement: %', receipt;
  end if;
end;
$$;

\echo '9/14 unrelated and inactive authenticated users cannot resolve a request'
reset role;
insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
(
  '00000000-0000-0000-0000-000000000000',
  '32000000-0000-4000-8000-000000000101',
  'authenticated', 'authenticated', 'inactive-owner@example.test',
  extensions.crypt('LocalOnly1!', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
);
insert into public.company_memberships(
  company_id, user_id, role, active
)
values (
  '10000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000101',
  'owner',
  false
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"32000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.sub', '32000000-0000-4000-8000-000000000101', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.resolve_customer_quote_change_request(
      '10000000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000005',
      (select request_id from commercial_resolution_fixture),
      2,
      'cancelled',
      null,
      null,
      'Unauthorized cancellation attempt.',
      '{}',
      repeat('0', 64)
    );
  exception when others then
    blocked := position('QUOTE_CHANGE_RESOLUTION_ROLE_REQUIRED' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Inactive non-member reached staff resolution';
  end if;
end;
$$;

\echo '10/14 accepted quote rows are immutable for every authenticated role'
reset role;
do $$
declare
  blocked boolean := false;
begin
  begin
    update public.quotes
    set terms_snapshot = 'mutated'
    where id = '10000000-0000-4000-8000-000000000521';
  exception when others then
    blocked := position('ACCEPTED_QUOTE_IMMUTABLE' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Accepted quote was mutable';
  end if;
end;
$$;

\echo '11/14 SET ROLE service_role without a JWT service claim fails closed'
set local role service_role;
select set_config('request.jwt.claims', '{}', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
do $$
declare
  load_blocked boolean := false;
  prepare_blocked boolean := false;
  complete_blocked boolean := false;
  fail_blocked boolean := false;
begin
  begin
    perform public.load_storyops_invoice_checkout_validation(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000651'
    );
  exception when others then
    load_blocked := position('EDGE_SERVICE_ROLE_REQUIRED' in sqlerrm) > 0;
  end;
  begin
    perform public.prepare_storyops_invoice_checkout(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000104',
      '32000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000651',
      1
    );
  exception when others then
    prepare_blocked := position('EDGE_SERVICE_ROLE_REQUIRED' in sqlerrm) > 0;
  end;
  begin
    perform public.complete_storyops_invoice_checkout(
      '10000000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000006',
      repeat('0', 64),
      '10000000-0000-4000-8000-000000000655',
      'cs_denied',
      '{}'::jsonb
    );
  exception when others then
    complete_blocked := position('EDGE_SERVICE_ROLE_REQUIRED' in sqlerrm) > 0;
  end;
  begin
    perform public.fail_storyops_invoice_checkout(
      '10000000-0000-4000-8000-000000000001',
      '32000000-0000-4000-8000-000000000006',
      repeat('0', 64),
      'DENIED'
    );
  exception when others then
    fail_blocked := position('EDGE_SERVICE_ROLE_REQUIRED' in sqlerrm) > 0;
  end;
  if not load_blocked or not prepare_blocked or not complete_blocked or not fail_blocked then
    raise exception 'One service-role RPC accepted a missing JWT role claim';
  end if;
end;
$$;

\echo '12/14 draft and void invoices are not payable; an issued exact balance is'
reset role;
-- The production service role has no tenant-table SELECT. Grant read-only
-- assertion access only inside this rolled-back test transaction, after the
-- ACL boundary has already been proven above.
grant select on public.invoices, public.payments to service_role;
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  blocked boolean := false;
  invoice_version integer;
begin
  select version
  into invoice_version
  from public.invoices
  where id = '10000000-0000-4000-8000-000000000651';
  begin
    perform public.prepare_storyops_invoice_checkout(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000104',
      '32000000-0000-4000-8000-000000000009',
      '10000000-0000-4000-8000-000000000651',
      invoice_version
    );
  exception when others then
    blocked := position('INVOICE_CHECKOUT_NOT_PAYABLE' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Draft invoice reached checkout preparation';
  end if;
end;
$$;

reset role;
insert into public.invoices(
  id, company_id, invoice_number, customer_id, job_id, purpose, status,
  issue_date, due_date, subtotal, tax, total, amount_paid, balance_due
)
values (
  '32000000-0000-4000-8000-000000000652',
  '10000000-0000-4000-8000-000000000001',
  'INV-COMMERCIAL-VOID',
  '10000000-0000-4000-8000-000000000201',
  null,
  'job',
  'void',
  current_date,
  current_date,
  100.00,
  0,
  100.00,
  0,
  100.00
);
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.prepare_storyops_invoice_checkout(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000104',
      '32000000-0000-4000-8000-000000000010',
      '32000000-0000-4000-8000-000000000652',
      1
    );
  exception when others then
    blocked := position('INVOICE_CHECKOUT_NOT_PAYABLE' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Void invoice reached checkout preparation';
  end if;
end;
$$;

reset role;
update public.invoices
set status = 'open',
    issue_date = current_date,
    due_date = current_date,
    amount_paid = 132.00,
    balance_due = 396.00
where id = '10000000-0000-4000-8000-000000000651';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  invoice_version integer;
  claim jsonb;
begin
  select version into invoice_version
  from public.invoices
  where id = '10000000-0000-4000-8000-000000000651';
  claim := public.prepare_storyops_invoice_checkout(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000104',
    '32000000-0000-4000-8000-000000000007',
    '10000000-0000-4000-8000-000000000651',
    invoice_version
  );
  if claim ->> 'claimStatus' <> 'reserved'
    or claim ->> 'amount' <> '396.00'
    or (claim ->> 'invoiceVersion')::integer <> invoice_version
    or not exists (
      select 1
      from public.payments payment
      where payment.id = (claim ->> 'paymentId')::uuid
        and payment.payment_type = 'invoice'
        and payment.status = 'pending'
        and payment.amount = 396.00
        and payment.provider_payment_id is null
    )
  then
    raise exception 'Invoice checkout did not reserve the exact pending balance: %', claim;
  end if;
end;
$$;

\echo '13/14 cross-customer invoice IDs fail before pricing or provider work'
reset role;
insert into public.customers(
  id, company_id, display_name, email, phone
)
values (
  '32000000-0000-4000-8000-000000000201',
  '10000000-0000-4000-8000-000000000001',
  'Other Customer',
  'other-customer@example.test',
  '+12145550999'
);
insert into public.properties(
  id, company_id, customer_id, name, property_type, service_address
)
values (
  '32000000-0000-4000-8000-000000000211',
  '10000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000201',
  'Other Property',
  'single_family',
  '{"line1":"1 Other St","city":"Dallas","region":"TX","postalCode":"75201","country":"US"}'
);
insert into public.quotes(
  id, company_id, quote_number, estimate_id, customer_id, property_id, status,
  valid_until, terms_version, terms_snapshot, total, deposit_required
)
values (
  '32000000-0000-4000-8000-000000000523',
  '10000000-0000-4000-8000-000000000001',
  'Q-OTHER-1',
  '10000000-0000-4000-8000-000000000501',
  '32000000-0000-4000-8000-000000000201',
  '32000000-0000-4000-8000-000000000211',
  'sent',
  current_date + 14,
  'terms-v1',
  'Other customer fixture.',
  528.00,
  132.00
);
insert into public.jobs(
  id, company_id, job_number, quote_id, customer_id, property_id, status,
  service_codes, estimated_duration_minutes, estimated_revenue, estimated_cost
)
values (
  '32000000-0000-4000-8000-000000000631',
  '10000000-0000-4000-8000-000000000001',
  'JOB-OTHER-1',
  '32000000-0000-4000-8000-000000000523',
  '32000000-0000-4000-8000-000000000201',
  '32000000-0000-4000-8000-000000000211',
  'invoiced',
  array['gutter-cleaning'],
  60,
  528.00,
  100.00
);
insert into public.invoices(
  id, company_id, invoice_number, customer_id, job_id, purpose, status,
  issue_date, due_date, subtotal, tax, total, amount_paid, balance_due
)
values (
  '32000000-0000-4000-8000-000000000651',
  '10000000-0000-4000-8000-000000000001',
  'INV-OTHER-1',
  '32000000-0000-4000-8000-000000000201',
  '32000000-0000-4000-8000-000000000631',
  'job',
  'open',
  current_date,
  current_date,
  500.00,
  28.00,
  528.00,
  0,
  528.00
);
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000104","role":"service_role"}',
  true
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000104', true);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.prepare_storyops_invoice_checkout(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000104',
      '32000000-0000-4000-8000-000000000008',
      '32000000-0000-4000-8000-000000000651',
      1
    );
  exception when others then
    blocked := position('INVOICE_CHECKOUT_CUSTOMER_SCOPE_DENIED' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Customer reached another customer invoice checkout';
  end if;
end;
$$;

\echo '14/14 migration and schema copies are validated by the release runner'
reset role;
revoke select on public.invoices, public.payments from service_role;
do $$
begin
  if not exists (
    select 1 from public.audit_events event
    where event.action = 'quote.change_request'
      and event.entity_type = 'customer_quote_change_request'
  ) or not exists (
    select 1 from public.audit_events event
    where event.action = 'quote.change_request.resolve'
      and event.entity_type = 'customer_quote_change_request'
  ) then
    raise exception 'Commercial lifecycle audit evidence is incomplete';
  end if;
end;
$$;

rollback;
