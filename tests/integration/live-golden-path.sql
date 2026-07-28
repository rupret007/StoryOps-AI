\set ON_ERROR_STOP on

begin;

delete from public.dispatch_assignments
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.visit_checklist_items
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.visits
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.payments
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.invoice_lines
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.invoices
where company_id = '10000000-0000-4000-8000-000000000001';
delete from public.jobs
where company_id = '10000000-0000-4000-8000-000000000001';

do $$
declare
  company_id_value constant uuid := '10000000-0000-4000-8000-000000000001';
  customer_user_id constant uuid := '10000000-0000-4000-8000-000000000104';
  dispatcher_user_id constant uuid := '10000000-0000-4000-8000-000000000102';
  technician_user_id constant uuid := '10000000-0000-4000-8000-000000000103';
  quote_id_value constant uuid := '10000000-0000-4000-8000-000000000521';
  checkout_command_id constant uuid := '91000000-0000-4000-8000-000000000001';
  booking_command_id constant uuid := '91000000-0000-4000-8000-000000000002';
  invoice_command_id constant uuid := '91000000-0000-4000-8000-000000000003';
  claim jsonb;
  response jsonb;
  booking jsonb;
  replay jsonb;
  issuance jsonb;
  job_id_value uuid;
  invoice_id_value uuid;
  payment_id_value uuid;
  visit_id_value uuid;
  job_version_value integer;
  invoice_version_value integer;
  visit_version_value integer;
  receipt jsonb;
begin
  claim := public.prepare_storyops_deposit_checkout(
    company_id_value,
    customer_user_id,
    checkout_command_id,
    quote_id_value,
    1
  );
  if claim ->> 'claimStatus' <> 'reserved'
    or claim ->> 'amount' <> '132.00'
    or claim ->> 'providerIdempotencyKey'
      <> 'storyops:deposit:' || quote_id_value::text
  then
    raise exception 'Checkout preparation contract failed: %', claim;
  end if;

  job_id_value := (claim ->> 'jobId')::uuid;
  invoice_id_value := (claim ->> 'invoiceId')::uuid;
  payment_id_value := (claim ->> 'paymentId')::uuid;
  update public.route_checks
  set request_payload = request_payload
    || jsonb_build_object('jobId', job_id_value)
  where id = '10000000-0000-4000-8000-000000000621';

  begin
    perform public.prepare_storyops_deposit_checkout(
      company_id_value,
      technician_user_id,
      '91000000-0000-4000-8000-000000000011',
      quote_id_value,
      1
    );
    raise exception 'Technician checkout unexpectedly succeeded';
  exception
    when others then
      if sqlerrm not like '%GOLDEN_PATH_CHECKOUT_ROLE_REQUIRED%' then
        raise;
      end if;
  end;

  response := jsonb_build_object(
    'action', 'deposit.checkout',
    'status', 'checkout_open',
    'mode', 'sandbox',
    'quoteId', quote_id_value,
    'jobId', job_id_value,
    'invoiceId', invoice_id_value,
    'amount', '132.00',
    'currency', 'USD',
    'paymentVerified', false,
    'depositReady', false,
    'replayed', false,
    'checkoutId', 'cs_golden_path_test',
    'sandboxReceipt', 'Sandbox only; no payment success.'
  );
  perform public.complete_storyops_deposit_checkout(
    company_id_value,
    checkout_command_id,
    claim ->> 'requestHash',
    payment_id_value,
    'cs_golden_path_test',
    response
  );

  claim := public.prepare_storyops_deposit_checkout(
    company_id_value,
    customer_user_id,
    checkout_command_id,
    quote_id_value,
    1
  );
  if claim ->> 'claimStatus' <> 'completed'
    or claim -> 'storedResponse' ->> 'paymentVerified' <> 'false'
  then
    raise exception 'Checkout replay contract failed: %', claim;
  end if;

  select version
  into job_version_value
  from public.jobs
  where id = job_id_value;

  perform set_config('request.jwt.claim.sub', dispatcher_user_id::text, true);
  begin
    perform public.execute_storyops_golden_path_command(
      company_id_value,
      booking_command_id,
      'job.book',
      job_version_value,
      jsonb_build_object('entityId', job_id_value),
      repeat('0', 64)
    );
    raise exception 'Booking without provider proof unexpectedly succeeded';
  exception
    when others then
      if sqlerrm not like '%GOLDEN_PATH_VERIFIED_DEPOSIT_REQUIRED%' then
        raise;
      end if;
  end;

  update public.payments
  set
    status = 'succeeded',
    provider_payment_id = 'pi_golden_path_test',
    processed_at = now()
  where id = payment_id_value;

  receipt := jsonb_build_object(
    'schemaVersion', 'storyops-provider-receipt-v1',
    'provider', 'stripe',
    'eventId', 'evt_golden_path_test',
    'eventType', 'checkout.session.completed',
    'objectId', 'cs_golden_path_test',
    'objectKind', 'checkout',
    'action', 'payment_succeeded',
    'companyId', company_id_value,
    'occurredAt', now()::text,
    'quoteId', quote_id_value,
    'paymentIntentId', 'pi_golden_path_test',
    'amountCents', 13200,
    'currency', 'usd'
  );
  insert into public.webhook_events(
    id, company_id, provider, provider_event_id, event_type, status,
    payload_hash, payload, processed_at
  )
  values (
    '91000000-0000-4000-8000-000000000021',
    company_id_value,
    'stripe',
    'evt_golden_path_test',
    'checkout.session.completed',
    'processed',
    encode(extensions.digest(receipt::text, 'sha256'), 'hex'),
    receipt,
    now()
  );

  if not public.storyops_payment_has_provider_proof(payment_id_value, quote_id_value) then
    raise exception 'Processed provider evidence did not verify the deposit';
  end if;
  if (
    select status
    from public.jobs
    where id = job_id_value
  ) <> 'ready_to_schedule' then
    raise exception 'Verified deposit did not make the job ready';
  end if;

  select version
  into job_version_value
  from public.jobs
  where id = job_id_value;
  booking := public.execute_storyops_golden_path_command(
    company_id_value,
    booking_command_id,
    'job.book',
    job_version_value,
    jsonb_build_object('entityId', job_id_value),
    repeat('0', 64)
  );
  if booking ->> 'status' <> 'applied'
    or booking ->> 'crewId' is null
    or booking ->> 'routeCheckId' is null
    or booking ->> 'weatherCheckId' is null
  then
    raise exception 'Capacity-aware booking failed: %', booking;
  end if;
  visit_id_value := (booking ->> 'entityId')::uuid;

  replay := public.execute_storyops_golden_path_command(
    company_id_value,
    booking_command_id,
    'job.book',
    job_version_value,
    jsonb_build_object('entityId', job_id_value),
    repeat('0', 64)
  );
  if replay ->> 'replayed' <> 'true'
    or replay ->> 'entityId' <> visit_id_value::text
  then
    raise exception 'Booking did not replay exactly: %', replay;
  end if;

  if exists (
    select 1
    from public.visits left_visit
    join public.visits right_visit
      on right_visit.crew_id = left_visit.crew_id
      and right_visit.id > left_visit.id
      and right_visit.starts_at < left_visit.ends_at
      and right_visit.ends_at > left_visit.starts_at
      and right_visit.status <> 'cancelled'
    where left_visit.company_id = company_id_value
      and left_visit.status <> 'cancelled'
  ) then
    raise exception 'Booking created a crew overlap';
  end if;

  update public.visits
  set status = 'completed'
  where id = visit_id_value;
  update public.jobs
  set status = 'completed'
  where id = job_id_value;

  select version
  into job_version_value
  from public.jobs
  where id = job_id_value;
  select version
  into visit_version_value
  from public.visits
  where id = visit_id_value;
  select version
  into invoice_version_value
  from public.invoices
  where id = invoice_id_value;

  issuance := public.execute_storyops_golden_path_command(
    company_id_value,
    invoice_command_id,
    'invoice.issue',
    job_version_value,
    jsonb_build_object(
      'entityId', job_id_value,
      'invoiceId', invoice_id_value,
      'invoiceVersion', invoice_version_value,
      'visitId', visit_id_value,
      'visitVersion', visit_version_value
    ),
    repeat('0', 64)
  );
  if issuance ->> 'status' <> 'applied'
    or issuance ->> 'amountPaid' <> '132.00'
    or issuance ->> 'balanceDue' <> '396.00'
  then
    raise exception 'Completion-backed invoice issuance failed: %', issuance;
  end if;

  replay := public.execute_storyops_golden_path_command(
    company_id_value,
    invoice_command_id,
    'invoice.issue',
    job_version_value,
    jsonb_build_object(
      'entityId', job_id_value,
      'invoiceId', invoice_id_value,
      'invoiceVersion', invoice_version_value,
      'visitId', visit_id_value,
      'visitVersion', visit_version_value
    ),
    repeat('0', 64)
  );
  if replay ->> 'replayed' <> 'true'
    or replay ->> 'entityId' <> invoice_id_value::text
  then
    raise exception 'Invoice issuance did not replay exactly: %', replay;
  end if;

  if (
    select count(*)
    from public.invoices
    where company_id = company_id_value
      and job_id = job_id_value
      and purpose = 'job'
  ) <> 1 then
    raise exception 'More than one job invoice was created';
  end if;
  if (
    select count(*)
    from public.invoice_lines
    where invoice_id = invoice_id_value
      and source_estimate_line_id is not null
  ) <> 3 then
    raise exception 'Accepted estimate lines were not copied exactly once';
  end if;
  if not exists (
    select 1
    from public.audit_events
    where company_id = company_id_value
      and entity_type in ('jobs', 'visits', 'invoices', 'payments')
  ) then
    raise exception 'Golden-path mutations were not appended to audit';
  end if;
end;
$$;

rollback;

\echo 'live golden path: pass'
