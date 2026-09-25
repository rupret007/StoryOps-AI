\set ON_ERROR_STOP on

begin;

insert into public.companies(id, name, status)
values (
  '99000000-0000-4000-8000-000000000002',
  'Transactional claim isolation',
  'active'
);

-- Production roles have no direct mutation grant. Temporary grants let this
-- rolled-back contract inspect exact worker state and emulate the already
-- verified provider-webhook write boundary.
grant select on
  public.transactional_delivery_attempts,
  public.communication_messages,
  public.communication_threads,
  public.audit_events
to service_role;
grant update on public.communication_messages to service_role;

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
  created_at
)
values (
  '39000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  'email',
  'transactional',
  'granted',
  now(),
  'written',
  'transactional-test-v1',
  'Rolled-back integration fixture for exact transactional email consent.',
  now() + interval '10 seconds'
);

insert into public.quotes(
  id,
  company_id,
  quote_number,
  estimate_id,
  customer_id,
  property_id,
  status,
  valid_until,
  terms_version,
  terms_snapshot,
  total,
  deposit_required
)
values
  (
    '39000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000001',
    'Q-TRANSACTIONAL-SANDBOX',
    '10000000-0000-4000-8000-000000000501',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'sent',
    current_date + 14,
    'terms-v1',
    'Exact rolled-back quote delivery fixture.',
    528.00,
    132.00
  ),
  (
    '39000000-0000-4000-8000-000000000102',
    '10000000-0000-4000-8000-000000000001',
    'Q-TRANSACTIONAL-LIVE',
    '10000000-0000-4000-8000-000000000501',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'sent',
    current_date + 14,
    'terms-v1',
    'Exact rolled-back live delivery fixture.',
    528.00,
    132.00
  ),
  (
    '39000000-0000-4000-8000-000000000103',
    '10000000-0000-4000-8000-000000000001',
    'Q-TRANSACTIONAL-UNPUBLISHED',
    '10000000-0000-4000-8000-000000000501',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'draft',
    current_date + 14,
    'terms-v1',
    'This draft must never be deliverable.',
    528.00,
    132.00
  ),
  (
    '39000000-0000-4000-8000-000000000104',
    '10000000-0000-4000-8000-000000000001',
    'Q-TRANSACTIONAL-CONSENT',
    '10000000-0000-4000-8000-000000000501',
    '10000000-0000-4000-8000-000000000201',
    '10000000-0000-4000-8000-000000000211',
    'sent',
    current_date + 14,
    'terms-v1',
    'Exact rolled-back consent cancellation fixture.',
    528.00,
    132.00
  );

set local role authenticated;
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

\echo '1/10 quote queue is finite, replay-safe, and never asserts provider delivery'
do $$
declare
  quote_version integer;
  request_hash text;
  receipt jsonb;
  replay jsonb;
  blocked boolean := false;
begin
  select (quote ->> 'version')::integer into quote_version
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'quotes'
  ) quote
  where quote ->> 'id' = '39000000-0000-4000-8000-000000000101';
  request_hash := encode(extensions.digest(
    'quote.delivery|39000000-0000-4000-8000-000000000101|'
      || quote_version::text || '|sms',
    'sha256'
  ), 'hex');
  receipt := public.queue_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000201',
    'quote.delivery',
    '39000000-0000-4000-8000-000000000101',
    quote_version,
    'sms',
    request_hash
  );
  replay := public.queue_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000201',
    'quote.delivery',
    '39000000-0000-4000-8000-000000000101',
    quote_version,
    'sms',
    request_hash
  );
  if receipt ->> 'status' <> 'queued'
    or (receipt ->> 'providerSubmissionAsserted')::boolean
    or (receipt ->> 'externalDeliveryClaimed')::boolean
    or not (replay ->> 'replayed')::boolean
    or (
      select count(*)
      from public.transactional_delivery_attempts attempt
      where attempt.command_id =
        '39000000-0000-4000-8000-000000000201'
    ) <> 1
  then
    raise exception 'Quote delivery queue/replay fabricated truth: %, %',
      receipt, replay;
  end if;
  begin
    perform public.queue_storyops_transactional_delivery(
      '10000000-0000-4000-8000-000000000001',
      '39000000-0000-4000-8000-000000000201',
      'quote.delivery',
      '39000000-0000-4000-8000-000000000101',
      quote_version,
      'email',
      encode(extensions.digest(
        'quote.delivery|39000000-0000-4000-8000-000000000101|'
          || quote_version::text || '|email',
        'sha256'
      ), 'hex')
    );
  exception when others then
    blocked := position(
      'TRANSACTIONAL_DELIVERY_IDEMPOTENCY_CONFLICT' in sqlerrm
    ) > 0;
  end;
  if not blocked then
    raise exception 'Command replay accepted a conflicting channel';
  end if;
end;
$$;

\echo '2/10 unpublished and stale quote requests fail before a message exists'
do $$
declare
  draft_version integer;
  blocked_unpublished boolean := false;
  blocked_stale boolean := false;
begin
  select (quote ->> 'version')::integer into draft_version
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'quotes'
  ) quote
  where quote ->> 'id' = '39000000-0000-4000-8000-000000000103';
  begin
    perform public.queue_storyops_transactional_delivery(
      '10000000-0000-4000-8000-000000000001',
      '39000000-0000-4000-8000-000000000202',
      'quote.delivery',
      '39000000-0000-4000-8000-000000000103',
      draft_version,
      'sms',
      encode(extensions.digest(
        'quote.delivery|39000000-0000-4000-8000-000000000103|'
          || draft_version::text || '|sms',
        'sha256'
      ), 'hex')
    );
  exception when others then
    blocked_unpublished := position(
      'TRANSACTIONAL_DELIVERY_QUOTE_NOT_PUBLISHED_OR_STALE' in sqlerrm
    ) > 0;
  end;
  begin
    perform public.queue_storyops_transactional_delivery(
      '10000000-0000-4000-8000-000000000001',
      '39000000-0000-4000-8000-000000000203',
      'quote.delivery',
      '39000000-0000-4000-8000-000000000102',
      999,
      'email',
      encode(extensions.digest(
        'quote.delivery|39000000-0000-4000-8000-000000000102|999|email',
        'sha256'
      ), 'hex')
    );
  exception when others then
    blocked_stale := position(
      'TRANSACTIONAL_DELIVERY_QUOTE_NOT_PUBLISHED_OR_STALE' in sqlerrm
    ) > 0;
  end;
  if not blocked_unpublished or not blocked_stale then
    raise exception 'Unpublished or stale quote reached the queue';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

\echo '3/10 sandbox worker result stays sandboxed and communication stays queued'
do $$
declare
  claim jsonb;
  cross_company_claim jsonb;
  completion jsonb;
  message_status text;
begin
  cross_company_claim := public.claim_storyops_transactional_delivery(
    '99000000-0000-4000-8000-000000000002',
    '39000000-0000-4000-8000-000000000300',
    90
  );
  if cross_company_claim is not null then
    raise exception 'Transactional claim crossed company scope: %',
      cross_company_claim;
  end if;
  claim := public.claim_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000301',
    90
  );
  completion := public.complete_storyops_transactional_delivery(
    (claim ->> 'attemptId')::uuid,
    (claim ->> 'claimToken')::uuid,
    jsonb_build_object(
      'provider', 'twilio',
      'providerId', 'SM_SANDBOX_TRANSACTIONAL_SQL',
      'mode', 'sandbox',
      'status', 'delivered',
      'occurredAt', now(),
      'idempotencyKey', claim ->> 'idempotencyKey'
    )
  );
  select message.delivery_status
  into message_status
  from public.transactional_delivery_attempts attempt
  join public.communication_messages message
    on message.id = attempt.communication_message_id
  where attempt.id = (claim ->> 'attemptId')::uuid;
  if completion ->> 'status' <> 'sandboxed'
    or (completion ->> 'externalDeliveryClaimed')::boolean
    or message_status <> 'queued'
  then
    raise exception 'Sandbox fabricated external delivery: %, %',
      completion, message_status;
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.role', '', true);
set local role authenticated;
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

\echo '4/10 live queue remains queued until worker and provider evidence arrive'
do $$
declare
  quote_version integer;
  request_hash text;
  receipt jsonb;
begin
  select (quote ->> 'version')::integer into quote_version
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'quotes'
  ) quote
  where quote ->> 'id' = '39000000-0000-4000-8000-000000000102';
  request_hash := encode(extensions.digest(
    'quote.delivery|39000000-0000-4000-8000-000000000102|'
      || quote_version::text || '|email',
    'sha256'
  ), 'hex');
  receipt := public.queue_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000204',
    'quote.delivery',
    '39000000-0000-4000-8000-000000000102',
    quote_version,
    'email',
    request_hash
  );
  if receipt ->> 'status' <> 'queued'
    or (receipt ->> 'externalDeliveryClaimed')::boolean
  then
    raise exception 'Browser queue asserted provider truth: %', receipt;
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);

\echo '5/10 accepted provider request is submitted, never delivered'
do $$
declare
  claim jsonb;
  boundary jsonb;
  completion jsonb;
  attempt_status text;
  message_status text;
begin
  claim := public.claim_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000302',
    90
  );
  boundary := public.begin_storyops_transactional_submission(
    (claim ->> 'attemptId')::uuid,
    (claim ->> 'claimToken')::uuid,
    'email'
  );
  completion := public.complete_storyops_transactional_delivery(
    (claim ->> 'attemptId')::uuid,
    (claim ->> 'claimToken')::uuid,
    jsonb_build_object(
      'provider', 'email',
      'providerId', 'EM_TRANSACTIONAL_QUEUED_SQL',
      'mode', 'live',
      'status', 'queued',
      'occurredAt', now(),
      'idempotencyKey', claim ->> 'idempotencyKey'
    )
  );
  select attempt.status, message.delivery_status
  into attempt_status, message_status
  from public.transactional_delivery_attempts attempt
  join public.communication_messages message
    on message.id = attempt.communication_message_id
  where attempt.id = (claim ->> 'attemptId')::uuid;
  if boundary ->> 'status' <> 'submitting'
    or completion ->> 'status' <> 'submitted'
    or (completion ->> 'externalDeliveryClaimed')::boolean
    or attempt_status <> 'submitted'
    or message_status <> 'queued'
  then
    raise exception 'Provider acceptance was treated as delivery: %, %, %',
      boundary, completion, message_status;
  end if;
end;
$$;

\echo '6/10 verified provider callback advances the exact message to delivered'
do $$
declare
  attempt_id_value uuid;
  message_id_value uuid;
  attempt_status text;
  delivery_claimed boolean;
begin
  select attempt.id, attempt.communication_message_id
  into attempt_id_value, message_id_value
  from public.transactional_delivery_attempts attempt
  where attempt.command_id =
    '39000000-0000-4000-8000-000000000204';
  perform set_config('storyops.provider_evidence_write', 'on', true);
  update public.communication_messages
  set
    delivery_status = 'delivered',
    sent_at = coalesce(sent_at, now())
  where id = message_id_value
    and provider_message_id = 'EM_TRANSACTIONAL_QUEUED_SQL';
  perform set_config('storyops.provider_evidence_write', 'off', true);
  select
    attempt.status,
    attempt.provider_mode = 'live'
      and attempt.status = 'delivered'
      and attempt.provider_status = 'delivered'
  into attempt_status, delivery_claimed
  from public.transactional_delivery_attempts attempt
  where attempt.id = attempt_id_value;
  if attempt_status <> 'delivered' or not delivery_claimed then
    raise exception 'Verified callback did not reconcile delivery';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.role', '', true);

\echo '7/10 consent withdrawal blocks new queueing and cancels an already queued attempt'
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
  withdrawn_at,
  created_at
)
values (
  '39000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  'sms',
  'transactional',
  'withdrawn',
  now(),
  'keyword',
  'transactional-test-v1',
  'Rolled-back STOP fixture.',
  now(),
  now() + interval '20 seconds'
);

set local role authenticated;
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
do $$
declare
  quote_version integer;
  blocked boolean := false;
begin
  select (quote ->> 'version')::integer into quote_version
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'quotes'
  ) quote
  where quote ->> 'id' = '39000000-0000-4000-8000-000000000104';
  begin
    perform public.queue_storyops_transactional_delivery(
      '10000000-0000-4000-8000-000000000001',
      '39000000-0000-4000-8000-000000000205',
      'quote.delivery',
      '39000000-0000-4000-8000-000000000104',
      quote_version,
      'sms',
      encode(extensions.digest(
        'quote.delivery|39000000-0000-4000-8000-000000000104|'
          || quote_version::text || '|sms',
        'sha256'
      ), 'hex')
    );
  exception when others then
    blocked := position(
      'TRANSACTIONAL_DELIVERY_CONSENT_NOT_GRANTED' in sqlerrm
    ) > 0;
  end;
  if not blocked then
    raise exception 'Withdrawn consent was bypassed';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

-- Restore current SMS consent, queue a visit, then revoke it before claim.
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
  created_at
)
values (
  '39000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  'sms',
  'transactional',
  'granted',
  now(),
  'written',
  'transactional-test-v1',
  'Rolled-back current grant fixture.',
  now() + interval '30 seconds'
);
-- Test-only bootstrap: the dispatch-clearance contract separately proves that
-- authenticated and generic paths cannot enter en_route. This delivery test
-- needs an already-cleared visit so it can exercise on-my-way consent.
alter table public.visits disable trigger visits_dispatch_clearance_guard;
update public.visits
set
  status = 'en_route',
  starts_at = now() + interval '30 minutes',
  ends_at = now() + interval '4 hours'
where id = '10000000-0000-4000-8000-000000000641';
alter table public.visits enable trigger visits_dispatch_clearance_guard;

set local role authenticated;
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
do $$
declare
  visit_version integer;
begin
  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';
  perform public.queue_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000206',
    'visit.on_my_way',
    '10000000-0000-4000-8000-000000000641',
    visit_version,
    'sms',
    encode(extensions.digest(
      'visit.on_my_way|10000000-0000-4000-8000-000000000641|'
        || visit_version::text || '|sms',
      'sha256'
    ), 'hex')
  );
end;
$$;
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

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
  withdrawn_at,
  created_at
)
values (
  '39000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  'sms',
  'transactional',
  'withdrawn',
  now(),
  'keyword',
  'transactional-test-v1',
  'Rolled-back withdrawal after queue.',
  now(),
  now() + interval '40 seconds'
);

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  claim jsonb;
  attempt_status text;
begin
  claim := public.claim_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000303',
    90
  );
  select status into attempt_status
  from public.transactional_delivery_attempts
  where command_id = '39000000-0000-4000-8000-000000000206';
  if claim is not null or attempt_status <> 'cancelled' then
    raise exception 'Stale consent reached provider claim: %, %',
      claim, attempt_status;
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.role', '', true);

\echo '8/10 stale visit version and stale en-route state fail closed'
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
  created_at
)
values (
  '39000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  'sms',
  'transactional',
  'granted',
  now(),
  'written',
  'transactional-test-v1',
  'Rolled-back final current grant.',
  now() + interval '50 seconds'
);
set local role authenticated;
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
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.queue_storyops_transactional_delivery(
      '10000000-0000-4000-8000-000000000001',
      '39000000-0000-4000-8000-000000000207',
      'visit.on_my_way',
      '10000000-0000-4000-8000-000000000641',
      999,
      'sms',
      encode(extensions.digest(
        'visit.on_my_way|10000000-0000-4000-8000-000000000641|999|sms',
        'sha256'
      ), 'hex')
    );
  exception when others then
    blocked := position(
      'TRANSACTIONAL_DELIVERY_VISIT_NOT_CURRENT_EN_ROUTE' in sqlerrm
    ) > 0;
  end;
  if not blocked then
    raise exception 'Stale visit version was queued';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

\echo '9/10 paused company rejects browser queue and worker cancels queued work'
set local role authenticated;
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
do $$
declare
  visit_version integer;
begin
  select (visit ->> 'version')::integer into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';
  perform public.queue_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000208',
    'visit.on_my_way',
    '10000000-0000-4000-8000-000000000641',
    visit_version,
    'sms',
    encode(extensions.digest(
      'visit.on_my_way|10000000-0000-4000-8000-000000000641|'
        || visit_version::text || '|sms',
      'sha256'
    ), 'hex')
  );
end;
$$;
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
update public.companies
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000001';

set local role authenticated;
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
do $$
declare
  quote_version integer;
  blocked boolean := false;
begin
  -- The rolled-back fixture was inserted above at its default version 1. Avoid
  -- calling the workspace projection after the company is intentionally paused.
  quote_version := 1;
  begin
    perform public.queue_storyops_transactional_delivery(
      '10000000-0000-4000-8000-000000000001',
      '39000000-0000-4000-8000-000000000209',
      'quote.delivery',
      '39000000-0000-4000-8000-000000000104',
      quote_version,
      'email',
      encode(extensions.digest(
        'quote.delivery|39000000-0000-4000-8000-000000000104|'
          || quote_version::text || '|email',
        'sha256'
      ), 'hex')
    );
  exception when others then
    blocked := position('STORYOPS_COMPANY_NOT_ACTIVE' in sqlerrm) > 0;
  end;
  if not blocked then
    raise exception 'Paused company queued a browser delivery';
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  claim jsonb;
  attempt_status text;
begin
  claim := public.claim_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000304',
    90
  );
  select status into attempt_status
  from public.transactional_delivery_attempts
  where command_id = '39000000-0000-4000-8000-000000000208';
  if claim is not null or attempt_status <> 'cancelled' then
    raise exception 'Paused company reached provider claim: %, %',
      claim, attempt_status;
  end if;
end;
$$;
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.role', '', true);
update public.companies
set status = 'active'
where id = '10000000-0000-4000-8000-000000000001';

\echo '10/10 provider failures retry or terminalize without fake delivery'
-- Build one exact attempt directly as migration context so the failure RPC can
-- be exercised independently from prior command/channel uniqueness.
insert into public.communication_threads(
  id,
  company_id,
  customer_id,
  subject,
  status
)
values (
  '39000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000201',
  'Provider failure fixture',
  'open'
);
insert into public.communication_messages(
  id,
  company_id,
  thread_id,
  channel,
  direction,
  sender,
  recipients,
  body,
  delivery_status,
  consent_record_id,
  sent_by_agent
)
values (
  '39000000-0000-4000-8000-000000000402',
  '10000000-0000-4000-8000-000000000001',
  '39000000-0000-4000-8000-000000000401',
  'email',
  'outbound',
  'WashOps contract',
  array['customer@storyops.local'],
  'Synthetic provider failure fixture.',
  'queued',
  '39000000-0000-4000-8000-000000000001',
  'transactional-outbound-worker-v1'
);
insert into public.transactional_delivery_attempts(
  id,
  company_id,
  action_type,
  quote_id,
  entity_version,
  customer_id,
  channel,
  consent_record_id,
  communication_message_id,
  command_id,
  request_hash,
  max_attempts,
  next_attempt_at,
  requested_by_user_id
)
select
  '39000000-0000-4000-8000-000000000403',
  '10000000-0000-4000-8000-000000000001',
  'quote_delivery',
  '39000000-0000-4000-8000-000000000104',
  quote.version,
  '10000000-0000-4000-8000-000000000201',
  'email',
  '39000000-0000-4000-8000-000000000001',
  '39000000-0000-4000-8000-000000000402',
  '39000000-0000-4000-8000-000000000404',
  repeat('a', 64),
  1,
  now() - interval '1 second',
  '10000000-0000-4000-8000-000000000101'
from public.quotes quote
where quote.id = '39000000-0000-4000-8000-000000000104';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  claim jsonb;
  failure jsonb;
  message_status text;
begin
  claim := public.claim_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000305',
    90
  );
  failure := public.fail_storyops_transactional_delivery(
    (claim ->> 'attemptId')::uuid,
    (claim ->> 'claimToken')::uuid,
    'HTTP_503',
    true
  );
  select message.delivery_status
  into message_status
  from public.transactional_delivery_attempts attempt
  join public.communication_messages message
    on message.id = attempt.communication_message_id
  where attempt.id = '39000000-0000-4000-8000-000000000403';
  if failure ->> 'status' <> 'failed'
    or (failure ->> 'externalDeliveryClaimed')::boolean
    or message_status <> 'failed'
  then
    raise exception 'Provider failure fabricated success: %, %',
      failure, message_status;
  end if;
end;
$$;

\echo '11/11 reconciliation read failures preserve provider truth and block duplicate sends'
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);

insert into public.communication_threads(
  id,
  company_id,
  customer_id,
  subject,
  status
)
values
  (
    '39000000-0000-4000-8000-000000000411',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'Reconciliation failure fixture',
    'open'
  ),
  (
    '39000000-0000-4000-8000-000000000421',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000201',
    'Reconciliation sweep fixture',
    'open'
  );

insert into public.communication_messages(
  id,
  company_id,
  thread_id,
  channel,
  direction,
  sender,
  recipients,
  body,
  delivery_status,
  provider_message_id,
  consent_record_id,
  sent_by_agent
)
values
  (
    '39000000-0000-4000-8000-000000000412',
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000411',
    'email',
    'outbound',
    'WashOps contract',
    array['customer@storyops.local'],
    'Synthetic accepted-provider reconciliation fixture.',
    'queued',
    'EM_RECONCILIATION_TRUTH_001',
    '39000000-0000-4000-8000-000000000001',
    'transactional-outbound-worker-v1'
  ),
  (
    '39000000-0000-4000-8000-000000000422',
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000421',
    'sms',
    'outbound',
    'WashOps contract',
    array['+12145550100'],
    'Synthetic final reconciliation-lease fixture.',
    'sent',
    'SM_RECONCILIATION_TRUTH_002',
    '39000000-0000-4000-8000-000000000005',
    'transactional-outbound-worker-v1'
  );

insert into public.transactional_delivery_attempts(
  id,
  company_id,
  action_type,
  quote_id,
  entity_version,
  customer_id,
  channel,
  consent_record_id,
  communication_message_id,
  command_id,
  request_hash,
  status,
  provider_mode,
  provider_name,
  provider_status,
  provider_message_id,
  reconciliation_count,
  max_attempts,
  next_attempt_at,
  claimed_by,
  claim_token,
  claim_operation,
  claim_expires_at,
  requested_by_user_id
)
select
  '39000000-0000-4000-8000-000000000413',
  '10000000-0000-4000-8000-000000000001',
  'quote_delivery',
  quote.id,
  quote.version,
  '10000000-0000-4000-8000-000000000201',
  'email',
  '39000000-0000-4000-8000-000000000001',
  '39000000-0000-4000-8000-000000000412',
  '39000000-0000-4000-8000-000000000414',
  repeat('b', 64),
  'submitted',
  'live',
  'email',
  'accepted',
  'EM_RECONCILIATION_TRUTH_001',
  2,
  2,
  now() - interval '1 second',
  '39000000-0000-4000-8000-000000000415',
  '39000000-0000-4000-8000-000000000416',
  'reconcile',
  now() + interval '90 seconds',
  '10000000-0000-4000-8000-000000000101'
from public.quotes quote
where quote.id = '39000000-0000-4000-8000-000000000104';

insert into public.transactional_delivery_attempts(
  id,
  company_id,
  action_type,
  quote_id,
  entity_version,
  customer_id,
  channel,
  consent_record_id,
  communication_message_id,
  command_id,
  request_hash,
  status,
  provider_mode,
  provider_name,
  provider_status,
  provider_message_id,
  reconciliation_count,
  max_attempts,
  next_attempt_at,
  requested_by_user_id
)
select
  '39000000-0000-4000-8000-000000000423',
  '10000000-0000-4000-8000-000000000001',
  'quote_delivery',
  quote.id,
  quote.version,
  '10000000-0000-4000-8000-000000000201',
  'sms',
  '39000000-0000-4000-8000-000000000005',
  '39000000-0000-4000-8000-000000000422',
  '39000000-0000-4000-8000-000000000424',
  repeat('c', 64),
  'submitted',
  'live',
  'twilio',
  'sent',
  'SM_RECONCILIATION_TRUTH_002',
  2,
  2,
  now() - interval '1 second',
  '10000000-0000-4000-8000-000000000101'
from public.quotes quote
where quote.id = '39000000-0000-4000-8000-000000000103';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);
do $$
declare
  retryable_failure jsonb;
  nonretryable_failure jsonb;
  sweep_claim jsonb;
  message_status text;
  sweep_message_status text;
  quarantined_attempt_count integer;
  fabricated_failure_audit_count integer;
  reconciliation_required_audit_count integer;
  sweep_attempt_state jsonb;
  sweep_audit_actions jsonb;
  sweep_candidate_count integer;
begin
  retryable_failure := public.fail_storyops_transactional_delivery(
    '39000000-0000-4000-8000-000000000413',
    '39000000-0000-4000-8000-000000000416',
    'HTTP_503',
    true
  );

  -- Exercise the nonretryable read-error path on the same known submission.
  reset role;
  update public.transactional_delivery_attempts
  set
    last_error_code = null,
    reconciliation_count = 1,
    claimed_by = '39000000-0000-4000-8000-000000000417',
    claim_token = '39000000-0000-4000-8000-000000000418',
    claim_operation = 'reconcile',
    claim_expires_at = now() + interval '90 seconds'
  where id = '39000000-0000-4000-8000-000000000413';
  set local role service_role;
  nonretryable_failure := public.fail_storyops_transactional_delivery(
    '39000000-0000-4000-8000-000000000413',
    '39000000-0000-4000-8000-000000000418',
    'RECEIPT_LOOKUP_UNSUPPORTED',
    false
  );
  select count(*)
  into sweep_candidate_count
  from public.transactional_delivery_attempts attempt
  where attempt.company_id = '10000000-0000-4000-8000-000000000001'
    and not (
      attempt.status = 'submitted'
      and attempt.last_error_code is not distinct from
        'RECONCILIATION_EXHAUSTED'
    )
    and (
      (
        attempt.status in ('queued', 'submitted')
        and attempt.next_attempt_at <= now()
        and (
          attempt.claim_token is null
          or attempt.claim_expires_at <= now()
        )
      )
      or (
        attempt.status = 'submitting'
        and attempt.claim_expires_at <= now()
      )
    );
  sweep_claim := public.claim_storyops_transactional_delivery(
    '10000000-0000-4000-8000-000000000001',
    '39000000-0000-4000-8000-000000000419',
    90
  );

  select message.delivery_status
  into message_status
  from public.communication_messages message
  where message.id = '39000000-0000-4000-8000-000000000412';
  select message.delivery_status
  into sweep_message_status
  from public.communication_messages message
  where message.id = '39000000-0000-4000-8000-000000000422';

  select count(*)
  into quarantined_attempt_count
  from public.transactional_delivery_attempts attempt
  where attempt.id in (
    '39000000-0000-4000-8000-000000000413',
    '39000000-0000-4000-8000-000000000423'
  )
    and attempt.status = 'submitted'
    and attempt.last_error_code = 'RECONCILIATION_EXHAUSTED'
    and attempt.completed_at is null
    and attempt.provider_mode = 'live'
    and attempt.provider_message_id is not null;

  select count(*)
  into fabricated_failure_audit_count
  from public.audit_events event
  where event.entity_id in (
    '39000000-0000-4000-8000-000000000413',
    '39000000-0000-4000-8000-000000000423'
  )
    and event.action in (
      'transactional_delivery.failed',
      'transactional_delivery.provider_failed'
    );

  select count(*)
  into reconciliation_required_audit_count
  from public.audit_events event
  where event.entity_id =
    '39000000-0000-4000-8000-000000000423'
    and event.action =
      'transactional_delivery.reconciliation_required'
    and event.after_data ->> 'status' = 'submitted'
    and event.after_data ->> 'errorCode'
      = 'RECONCILIATION_EXHAUSTED'
    and event.after_data ->> 'manualReconciliationRequired' = 'true'
    and event.after_data ->> 'externalDeliveryClaimed' = 'false';

  select jsonb_build_object(
    'status', attempt.status,
    'errorCode', attempt.last_error_code,
    'providerStatus', attempt.provider_status,
    'providerMessageId', attempt.provider_message_id,
    'completedAt', attempt.completed_at,
    'nextAttemptAt', attempt.next_attempt_at,
    'claimToken', attempt.claim_token,
    'claimExpiresAt', attempt.claim_expires_at,
    'reconciliationCount', attempt.reconciliation_count,
    'maxAttempts', attempt.max_attempts
  )
  into sweep_attempt_state
  from public.transactional_delivery_attempts attempt
  where attempt.id = '39000000-0000-4000-8000-000000000423';

  select coalesce(jsonb_agg(event.action order by event.occurred_at), '[]'::jsonb)
  into sweep_audit_actions
  from public.audit_events event
  where event.entity_id = '39000000-0000-4000-8000-000000000423';

  if retryable_failure ->> 'status' <> 'submitted'
    or retryable_failure ->> 'errorCode' <> 'RECONCILIATION_EXHAUSTED'
    or retryable_failure ->> 'providerReadErrorCode' <> 'HTTP_503'
    or retryable_failure ->> 'retryScheduled' <> 'false'
    or retryable_failure ->> 'manualReconciliationRequired' <> 'true'
    or nonretryable_failure ->> 'status' <> 'submitted'
    or nonretryable_failure ->> 'providerReadErrorCode'
      <> 'RECEIPT_LOOKUP_UNSUPPORTED'
    or nonretryable_failure ->> 'manualReconciliationRequired' <> 'true'
    or sweep_claim is not null
    or message_status <> 'queued'
    or sweep_message_status <> 'sent'
    or quarantined_attempt_count <> 2
    or fabricated_failure_audit_count <> 0
    or reconciliation_required_audit_count <> 1
  then
    raise exception
      'Reconciliation read failure fabricated provider failure: retryable=%, nonretryable=%, candidateCount=%, claim=%, message=%, sweepMessage=%, quarantined=%, fabricatedAudits=%, reconciliationAudits=%, sweepAttempt=%, sweepAudits=%',
      retryable_failure,
      nonretryable_failure,
      sweep_candidate_count,
      sweep_claim,
      message_status,
      sweep_message_status,
      quarantined_attempt_count,
      fabricated_failure_audit_count,
      reconciliation_required_audit_count,
      sweep_attempt_state,
      sweep_audit_actions;
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
set local role authenticated;
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
do $$
declare
  blocked_duplicate_email boolean := false;
  blocked_duplicate_sms boolean := false;
  workspace jsonb;
begin
  workspace := public.get_storyops_workspace(
    '10000000-0000-4000-8000-000000000001'
  );
  begin
    perform public.queue_storyops_transactional_delivery(
      '10000000-0000-4000-8000-000000000001',
      '39000000-0000-4000-8000-000000000431',
      'quote.delivery',
      '39000000-0000-4000-8000-000000000104',
      1,
      'email',
      encode(extensions.digest(
        'quote.delivery|39000000-0000-4000-8000-000000000104|1|email',
        'sha256'
      ), 'hex')
    );
  exception when others then
    blocked_duplicate_email := position(
      'TRANSACTIONAL_DELIVERY_ACTIVE_ATTEMPT_EXISTS' in sqlerrm
    ) > 0;
  end;
  begin
    perform public.queue_storyops_transactional_delivery(
      '10000000-0000-4000-8000-000000000001',
      '39000000-0000-4000-8000-000000000432',
      'quote.delivery',
      '39000000-0000-4000-8000-000000000104',
      1,
      'sms',
      encode(extensions.digest(
        'quote.delivery|39000000-0000-4000-8000-000000000104|1|sms',
        'sha256'
      ), 'hex')
    );
  exception when others then
    blocked_duplicate_sms := position(
      'TRANSACTIONAL_DELIVERY_ACTIVE_ATTEMPT_EXISTS' in sqlerrm
    ) > 0;
  end;
  if not blocked_duplicate_email
    or not blocked_duplicate_sms
    or not exists (
      select 1
      from jsonb_array_elements(
        workspace -> 'transactionalDeliveries'
      ) delivery
      where delivery ->> 'id'
        = '39000000-0000-4000-8000-000000000413'
        and delivery ->> 'status' = 'submitted'
        and delivery ->> 'manualReconciliationRequired' = 'true'
        and delivery ->> 'externalDeliveryClaimed' = 'false'
    )
  then
    raise exception
      'Manual reconciliation did not remain visible/duplicate-safe';
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', '', true);
select set_config('storyops.provider_evidence_write', 'on', true);
update public.communication_messages
set delivery_status = 'delivered'
where id = '39000000-0000-4000-8000-000000000412'
  and provider_message_id = 'EM_RECONCILIATION_TRUTH_001';
select set_config('storyops.provider_evidence_write', 'off', true);
do $$
begin
  if not exists (
    select 1
    from public.transactional_delivery_attempts attempt
    where attempt.id = '39000000-0000-4000-8000-000000000413'
      and attempt.status = 'delivered'
      and attempt.provider_status = 'delivered'
      and attempt.last_error_code is null
  ) then
    raise exception 'Verified provider callback could not resolve manual reconciliation';
  end if;
end;
$$;

select set_config('storyops.provider_evidence_write', 'on', true);
update public.communication_messages
set delivery_status = 'failed'
where id = '39000000-0000-4000-8000-000000000422'
  and provider_message_id = 'SM_RECONCILIATION_TRUTH_002';
select set_config('storyops.provider_evidence_write', 'off', true);
insert into public.audit_events(
  company_id,
  actor_type,
  actor_id,
  action,
  entity_type,
  entity_id,
  before_data,
  after_data
)
values (
  '10000000-0000-4000-8000-000000000001',
  'system',
  'transactional-outbound-worker-v1',
  'transactional_delivery.failed',
  'transactional_delivery_attempt',
  '39000000-0000-4000-8000-000000000423',
  jsonb_build_object('status', 'submitted'),
  jsonb_build_object(
    'status', 'failed',
    'errorCode', 'HTTP_503',
    'providerSubmissionAsserted', true,
    'externalDeliveryClaimed', false
  )
);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform private.storyops_assert_no_ambiguous_worker_upgrade_state();
  exception when others then
    blocked := position(
      'PRIVATE_WORKER_UPGRADE_TRANSACTIONAL_PROVIDER_TRUTH_RECONCILIATION_REQUIRED'
      in sqlerrm
    ) > 0;
  end;
  if not blocked then
    raise exception
      'Upgrade accepted a fabricated legacy provider-failure signature';
  end if;
end;
$$;

rollback;
