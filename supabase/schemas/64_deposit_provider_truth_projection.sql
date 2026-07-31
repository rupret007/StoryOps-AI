-- Project deposit readiness from the same signed provider-proof predicate used
-- by checkout and booking. Invoice amount_paid is job-balance accounting and is
-- not an authority for whether a quote deposit was proven.

alter function public.get_storyops_workspace(uuid)
  rename to get_storyops_workspace_before_deposit_truth;

revoke all on function public.get_storyops_workspace_before_deposit_truth(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_storyops_workspace(
  p_company_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  result := public.get_storyops_workspace_before_deposit_truth(p_company_id);
  if result #>> '{session,companyId}' is distinct from p_company_id::text
    or result #>> '{session,userId}' is distinct from auth.uid()::text
  then
    raise exception using message =
      'Workspace identity did not match the authenticated scope';
  end if;

  if result #>> '{session,role}' in ('owner', 'dispatcher') then
    result := result || jsonb_build_object(
      'depositEvidence',
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'quoteId', quote.id,
            'jobId', job.id,
            'invoiceId', invoice.id,
            'paymentId', proven_payment.id,
            'required', quote.deposit_required::text,
            'verified',
              coalesce(proven_payment.amount, 0::numeric(12,2))::text,
            'providerProof', proven_payment.id is not null,
            'ready',
              quote.deposit_required = 0
              or coalesce(proven_payment.amount, 0::numeric(12,2))
                >= quote.deposit_required
          )
          order by quote.accepted_at desc nulls last, quote.id desc
        )
        from public.quotes quote
        left join public.jobs job
          on job.company_id = quote.company_id
         and job.quote_id = quote.id
        left join public.invoices invoice
          on invoice.company_id = job.company_id
         and invoice.job_id = job.id
         and invoice.purpose = 'job'
        left join lateral (
          select payment.id, payment.amount
          from public.payments payment
          where payment.company_id = quote.company_id
            and payment.invoice_id = invoice.id
            and payment.payment_type = 'deposit'
            and public.storyops_payment_has_provider_proof(
              payment.id,
              quote.id
            )
          order by payment.processed_at desc, payment.id desc
          limit 1
        ) proven_payment on true
        where quote.company_id = p_company_id
          and quote.status = 'accepted'
      ), '[]'::jsonb)
    );
  end if;
  return result;
end;
$$;

revoke all on function public.get_storyops_workspace(uuid)
  from public, anon, service_role;
grant execute on function public.get_storyops_workspace(uuid)
  to authenticated;

alter function public.get_customer_portal_state(uuid)
  rename to get_customer_portal_state_before_deposit_truth;

revoke all on function public.get_customer_portal_state_before_deposit_truth(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.get_customer_portal_state(
  p_company_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public
as $$
declare
  base_state jsonb;
  customer_state jsonb;
  commercial_state jsonb;
  enriched_customers jsonb := '[]'::jsonb;
  customer_id_value uuid;
  deposit_evidence jsonb;
begin
  if auth.role() is distinct from 'authenticated'
    or auth.uid() is null
    or not public.is_active_company_portal_user(p_company_id)
  then
    raise exception using message = 'CUSTOMER_DEPOSIT_SCOPE_DENIED';
  end if;
  base_state := public.get_customer_portal_state_before_deposit_truth(
    p_company_id
  );
  if base_state ->> 'companyId' is distinct from p_company_id::text then
    raise exception using message = 'CUSTOMER_DEPOSIT_SCOPE_DENIED';
  end if;

  for customer_state in
    select value
    from jsonb_array_elements(coalesce(base_state -> 'customers', '[]'::jsonb))
  loop
    customer_id_value := (customer_state ->> 'customerId')::uuid;
    if not public.is_customer_user(p_company_id, customer_id_value) then
      raise exception using message = 'CUSTOMER_DEPOSIT_SCOPE_DENIED';
    end if;

    select jsonb_build_object(
      'quoteId', quote.id,
      'required', quote.deposit_required::text,
      'verified', coalesce(proven_payment.amount, 0::numeric(12,2))::text,
      'ready',
        quote.deposit_required = 0
        or coalesce(proven_payment.amount, 0::numeric(12,2))
          >= quote.deposit_required
    )
    into deposit_evidence
    from public.quotes quote
    left join public.jobs job
      on job.company_id = quote.company_id
     and job.quote_id = quote.id
    left join public.invoices invoice
      on invoice.company_id = job.company_id
     and invoice.job_id = job.id
     and invoice.purpose = 'job'
    left join lateral (
      select payment.id, payment.amount
      from public.payments payment
      where payment.company_id = quote.company_id
        and payment.invoice_id = invoice.id
        and payment.payment_type = 'deposit'
        and public.storyops_payment_has_provider_proof(payment.id, quote.id)
      order by payment.processed_at desc, payment.id desc
      limit 1
    ) proven_payment on true
    where quote.company_id = p_company_id
      and quote.customer_id = customer_id_value
      and quote.status = 'accepted'
    order by quote.accepted_at desc nulls last, quote.id desc
    limit 1;

    commercial_state := coalesce(
      customer_state -> 'commercial',
      '{}'::jsonb
    ) || jsonb_build_object('depositEvidence', deposit_evidence);
    enriched_customers := enriched_customers || jsonb_build_array(
      jsonb_set(
        customer_state,
        '{commercial}',
        commercial_state,
        true
      )
    );
  end loop;
  return jsonb_set(base_state, '{customers}', enriched_customers);
end;
$$;

revoke all on function public.get_customer_portal_state(uuid)
  from public, anon, service_role;
grant execute on function public.get_customer_portal_state(uuid)
  to authenticated;

comment on function public.get_storyops_workspace(uuid) is
  'Authenticated workspace with staff deposit readiness derived only from exact company/quote/invoice/payment correlation and signed provider proof.';
comment on function public.get_customer_portal_state(uuid) is
  'Authenticated customer portal state. Deposit readiness uses the same exact signed-provider predicate as checkout and booking, never invoice amount_paid inference.';
