\set ON_ERROR_STOP on

begin;

\echo '1/5 simultaneous estimate blockers become one complete canonical exact payload'
insert into public.estimates(
  id, company_id, estimate_number, customer_id, property_id, lead_id,
  price_book_id, price_book_version, status, service_subtotal,
  minimum_adjustment, travel_fee, manual_adjustment, discount,
  taxable_subtotal, tax, total, deposit_required, estimated_cost,
  estimated_margin_pct, duration_minutes, calculation_version,
  calculation_input, calculation_issues, evidence_analysis_ids, calculated_at
)
select
  '96500000-0000-4000-8000-000000000501',
  company_id,
  'EST-EXACT-APPROVAL-1',
  customer_id,
  property_id,
  null,
  price_book_id,
  price_book_version,
  'pending_approval',
  service_subtotal,
  minimum_adjustment,
  travel_fee,
  -10.00,
  102.69,
  taxable_subtotal,
  tax,
  total,
  deposit_required,
  estimated_cost,
  12.3400,
  duration_minutes,
  calculation_version,
  calculation_input,
  calculation_issues,
  evidence_analysis_ids,
  calculated_at
from public.estimates
where id = '10000000-0000-4000-8000-000000000501';

insert into public.quotes(
  id, company_id, quote_number, estimate_id, customer_id, property_id,
  status, valid_until, terms_version, terms_snapshot, total, deposit_required
)
select
  '96500000-0000-4000-8000-000000000521',
  estimate.company_id,
  'Q-EXACT-APPROVAL-1',
  estimate.id,
  estimate.customer_id,
  estimate.property_id,
  'pending_approval',
  current_date + 14,
  terms.version_label,
  terms.terms_text,
  estimate.total,
  estimate.deposit_required
from public.estimates estimate
join public.service_terms terms
  on terms.id = '10000000-0000-4000-8000-000000000152'
  and terms.company_id = estimate.company_id
where estimate.id = '96500000-0000-4000-8000-000000000501';

insert into public.approval_requests(
  id, company_id, reason, risk_level, status, requested_by_type,
  requested_by_id, requested_at, expires_at, entity_type, entity_id,
  action_type, action_payload, summary, policy_version
)
values (
  '96500000-0000-4000-8000-000000000801',
  '10000000-0000-4000-8000-000000000001',
  'other',
  'medium',
  'pending',
  'user',
  '10000000-0000-4000-8000-000000000101',
  now(),
  now() + interval '24 hours',
  'estimate',
  '96500000-0000-4000-8000-000000000501',
  'estimate.approve_exception',
  jsonb_build_object(
    'estimateId', '96500000-0000-4000-8000-000000000501',
    'quoteId', '96500000-0000-4000-8000-000000000521',
    'intentHash', repeat('a', 64),
    'authoritativeSnapshotHash', repeat('b', 64),
    'snapshot', jsonb_build_object(
      'priceBookId', '10000000-0000-4000-8000-000000000401',
      'priceBookVersion', '2026.1',
      'serviceTermsId', '10000000-0000-4000-8000-000000000152',
      'termsVersion', 'terms-v1',
      'calculationVersion', 'storyops-pricing-v1.0.0',
      'total', '528.00',
      'depositRequired', '132.00',
      'discount', '102.69',
      'marginPercent', '12.3400'
    ),
    'approvalFlags', jsonb_build_array(
      jsonb_build_object(
        'reason', 'uncertain_scope',
        'summary', 'Scope evidence still contains owner-review unknowns.',
        'blocking', true
      ),
      jsonb_build_object(
        'reason', 'price_exception',
        'summary', 'A manual price adjustment is outside automatic policy.',
        'blocking', true
      ),
      jsonb_build_object(
        'reason', 'margin_below_floor',
        'summary', 'The deterministic margin is below the published floor.',
        'blocking', true
      ),
      jsonb_build_object(
        'reason', 'large_discount',
        'summary', 'The discount exceeds the automatic limit.',
        'blocking', true
      )
    )
  ),
  'This caller-supplied summary must be replaced.',
  'storyops-policy-v1.0.0'
);

do $$
declare
  approval public.approval_requests%rowtype;
  expected_hash text;
begin
  select *
  into approval
  from public.approval_requests
  where id = '96500000-0000-4000-8000-000000000801';
  expected_hash := encode(
    extensions.digest(
      (approval.action_payload -> 'exactPayload')::text,
      'sha256'
    ),
    'hex'
  );
  if approval.reason <> 'large_discount'
    or approval.risk_level <> 'high'
    or approval.summary
      <> '4 blocking estimate exceptions require owner review of the exact payload.'
    or approval.action_payload ->> 'schemaVersion'
      <> 'storyops-estimate-approval-envelope-v1'
    or approval.action_payload #>> '{exactPayload,schemaVersion}'
      <> 'storyops-estimate-exception-exact-v1'
    or approval.action_payload #>> '{exactPayload,companyId}'
      <> approval.company_id::text
    or approval.action_payload ->> 'payloadHash' <> expected_hash
    or jsonb_array_length(
      approval.action_payload #> '{exactPayload,blockingFlags}'
    ) <> 4
    or (
      select array_agg(flag ->> 'reason' order by ordinal)
      from jsonb_array_elements(
        approval.action_payload #> '{exactPayload,blockingFlags}'
      ) with ordinality as blockers(flag, ordinal)
    ) <> array[
      'large_discount',
      'margin_below_floor',
      'price_exception',
      'uncertain_scope'
    ]
    or exists (
      select 1
      from jsonb_array_elements(
        approval.action_payload #> '{exactPayload,blockingFlags}'
      ) flag
      where flag ->> 'riskLevel' <> 'high'
        or (flag ->> 'blocking')::boolean is not true
    )
  then
    raise exception 'Estimate approval was not completely canonicalized: %',
      to_jsonb(approval);
  end if;
end;
$$;

\echo '2/5 owner workspace exposes the exact payload and its deterministic hash'
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
  projected jsonb;
  expected_hash text;
begin
  select value
  into projected
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'approvals'
  )
  where value ->> 'id' = '96500000-0000-4000-8000-000000000801';
  expected_hash := encode(
    extensions.digest((projected -> 'exactPayload')::text, 'sha256'),
    'hex'
  );
  if projected ->> 'payloadHash' <> expected_hash
    or jsonb_array_length(projected #> '{exactPayload,blockingFlags}') <> 4
    or projected ? 'action_payload'
  then
    raise exception 'Owner workspace did not expose the exact safe projection: %',
      projected;
  end if;
end;
$$;

\echo '3/5 a corrupted exact-payload hash fails before approval consumption'
reset role;
create temporary table exact_approval_backup as
select id, action_payload
from public.approval_requests
where id = '96500000-0000-4000-8000-000000000801';

alter table public.approval_requests
  disable trigger approval_requests_scope_immutable;
update public.approval_requests
set action_payload = jsonb_set(
  action_payload,
  '{payloadHash}',
  to_jsonb(repeat('0', 64))
)
where id = '96500000-0000-4000-8000-000000000801';
alter table public.approval_requests
  enable trigger approval_requests_scope_immutable;

set local role authenticated;
do $$
declare
  blocked boolean := false;
  approval jsonb;
  command_payload jsonb := jsonb_build_object(
    'entityId', '96500000-0000-4000-8000-000000000801',
    'decision', 'approved',
    'decisionNote', 'This corrupted hash must fail.'
  );
  request_hash text;
begin
  select value
  into approval
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'approvals'
  )
  where value ->> 'id' = '96500000-0000-4000-8000-000000000801';
  request_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'commandType', 'approval.decide',
        'expectedVersion', (approval ->> 'version')::integer,
        'payload', command_payload
      )::text,
      'sha256'
    ),
    'hex'
  );
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '96500000-0000-4000-8000-000000000811',
      'approval.decide',
      (approval ->> 'version')::integer,
      command_payload,
      request_hash
    );
  exception
    when others then
      if position('ESTIMATE_APPROVAL_PAYLOAD_HASH_MISMATCH' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'A corrupted exact-payload hash was approved';
  end if;
end;
$$;

\echo '4/5 authoritative snapshot drift also fails closed'
reset role;
alter table public.approval_requests
  disable trigger approval_requests_scope_immutable;
update public.approval_requests approval
set action_payload = backup.action_payload
from exact_approval_backup backup
where approval.id = backup.id;
alter table public.approval_requests
  enable trigger approval_requests_scope_immutable;

update public.estimates
set total = 529.00
where id = '96500000-0000-4000-8000-000000000501';

set local role authenticated;
do $$
declare
  blocked boolean := false;
  approval jsonb;
  command_payload jsonb := jsonb_build_object(
    'entityId', '96500000-0000-4000-8000-000000000801',
    'decision', 'approved',
    'decisionNote', 'This stale snapshot must fail.'
  );
  request_hash text;
begin
  select value
  into approval
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'approvals'
  )
  where value ->> 'id' = '96500000-0000-4000-8000-000000000801';
  request_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'commandType', 'approval.decide',
        'expectedVersion', (approval ->> 'version')::integer,
        'payload', command_payload
      )::text,
      'sha256'
    ),
    'hex'
  );
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '96500000-0000-4000-8000-000000000812',
      'approval.decide',
      (approval ->> 'version')::integer,
      command_payload,
      request_hash
    );
  exception
    when others then
      if position('ESTIMATE_APPROVAL_EXACT_PAYLOAD_MISMATCH' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Authoritative estimate drift was approved';
  end if;
end;
$$;

\echo '5/5 the unchanged exact payload is approved and consumed exactly once'
reset role;
update public.estimates
set total = 528.00
where id = '96500000-0000-4000-8000-000000000501';

set local role authenticated;
do $$
declare
  approval jsonb;
  command_payload jsonb := jsonb_build_object(
    'entityId', '96500000-0000-4000-8000-000000000801',
    'decision', 'approved',
    'decisionNote',
      'Owner reviewed all four blockers and the exact snapshot.'
  );
  request_hash text;
begin
  select value
  into approval
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'approvals'
  )
  where value ->> 'id' = '96500000-0000-4000-8000-000000000801';
  request_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'commandType', 'approval.decide',
        'expectedVersion', (approval ->> 'version')::integer,
        'payload', command_payload
      )::text,
      'sha256'
    ),
    'hex'
  );
  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '96500000-0000-4000-8000-000000000813',
    'approval.decide',
    (approval ->> 'version')::integer,
    command_payload,
    request_hash
  );
end;
$$;

reset role;
do $$
declare
  approval public.approval_requests%rowtype;
begin
  select *
  into approval
  from public.approval_requests
  where id = '96500000-0000-4000-8000-000000000801';
  if approval.status <> 'approved'
    or approval.consumed_at is null
    or approval.execution_receipt ->> 'schemaVersion'
      <> 'storyops-estimate-exception-consumption-v1'
    or approval.execution_receipt ->> 'payloadHash'
      <> approval.action_payload ->> 'payloadHash'
    or approval.execution_receipt -> 'snapshot'
      <> approval.action_payload #> '{exactPayload,snapshot}'
    or approval.execution_receipt -> 'blockingFlags'
      <> approval.action_payload #> '{exactPayload,blockingFlags}'
    or (
      select status
      from public.estimates
      where id = '96500000-0000-4000-8000-000000000501'
    ) <> 'approved'
    or (
      select status
      from public.quotes
      where id = '96500000-0000-4000-8000-000000000521'
    ) <> 'draft'
  then
    raise exception 'Exact estimate approval was not hash-bound and consumed: %',
      to_jsonb(approval);
  end if;
end;
$$;

rollback;
