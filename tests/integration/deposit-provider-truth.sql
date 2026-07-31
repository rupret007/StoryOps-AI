\set ON_ERROR_STOP on

begin;

\echo '1/4 signed deposit proof, not invoice amount_paid, drives both projections'
update public.invoices
set
  amount_paid = 0,
  balance_due = total
where id = '10000000-0000-4000-8000-000000000651';

do $$
begin
  if (
    select invoice.amount_paid
    from public.invoices invoice
    where invoice.id = '10000000-0000-4000-8000-000000000651'
  ) <> 0
    or not public.storyops_payment_has_provider_proof(
      '10000000-0000-4000-8000-000000000655',
      '10000000-0000-4000-8000-000000000521'
    )
  then
    raise exception 'Seed no longer isolates deposit proof from invoice balance';
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
do $$
declare
  portal jsonb;
  evidence jsonb;
begin
  portal := public.get_customer_portal_state(
    '10000000-0000-4000-8000-000000000001'
  );
  select customer.value #> '{commercial,depositEvidence}'
  into evidence
  from jsonb_array_elements(portal -> 'customers') customer(value)
  where customer.value ->> 'customerId'
    = '10000000-0000-4000-8000-000000000201';
  if evidence ->> 'quoteId'
      <> '10000000-0000-4000-8000-000000000521'
    or evidence ->> 'required' <> '132.00'
    or evidence ->> 'verified' <> '132.00'
    or (evidence ->> 'ready')::boolean is not true
  then
    raise exception 'Customer deposit projection contradicted signed proof: %',
      evidence;
  end if;
end;
$$;

\echo '2/4 staff projection is exact quote/job/invoice/payment correlated'
reset role;
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
  workspace jsonb;
  evidence jsonb;
begin
  workspace := public.get_storyops_workspace(
    '10000000-0000-4000-8000-000000000001'
  );
  select item.value
  into evidence
  from jsonb_array_elements(workspace -> 'depositEvidence') item(value)
  where item.value ->> 'quoteId'
    = '10000000-0000-4000-8000-000000000521';
  if evidence ->> 'jobId'
      <> '10000000-0000-4000-8000-000000000631'
    or evidence ->> 'invoiceId'
      <> '10000000-0000-4000-8000-000000000651'
    or evidence ->> 'paymentId'
      <> '10000000-0000-4000-8000-000000000655'
    or (evidence ->> 'providerProof')::boolean is not true
    or (evidence ->> 'ready')::boolean is not true
  then
    raise exception 'Staff deposit projection lost exact correlation: %',
      evidence;
  end if;
end;
$$;

\echo '3/4 succeeded status without the exact proof predicate fails closed'
reset role;
update public.payments
set allocation_status = 'unapplied'
where id = '10000000-0000-4000-8000-000000000655';

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
do $$
declare
  portal jsonb;
  evidence jsonb;
begin
  portal := public.get_customer_portal_state(
    '10000000-0000-4000-8000-000000000001'
  );
  select customer.value #> '{commercial,depositEvidence}'
  into evidence
  from jsonb_array_elements(portal -> 'customers') customer(value)
  where customer.value ->> 'customerId'
    = '10000000-0000-4000-8000-000000000201';
  if evidence ->> 'verified' <> '0.00'
    or (evidence ->> 'ready')::boolean
  then
    raise exception 'Status-only payment was treated as provider proof: %',
      evidence;
  end if;
end;
$$;

\echo '4/4 private predecessor projections remain inaccessible'
reset role;
do $$
begin
  if has_function_privilege(
    'authenticated',
    'public.get_storyops_workspace_before_deposit_truth(uuid)',
    'EXECUTE'
  )
    or has_function_privilege(
      'service_role',
      'public.get_storyops_workspace_before_deposit_truth(uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.get_customer_portal_state_before_deposit_truth(uuid)',
      'EXECUTE'
    )
    or has_function_privilege(
      'service_role',
      'public.get_customer_portal_state_before_deposit_truth(uuid)',
      'EXECUTE'
    )
  then
    raise exception 'A predecessor projection remained directly callable';
  end if;
end;
$$;

rollback;
