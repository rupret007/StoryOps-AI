\set ON_ERROR_STOP on

-- Server-authoritative profitability, cost-completeness, payment-evidence, and
-- role-isolation contract. This suite is transactional and preserves the seed.
begin;

\echo '1/6 complete owner profitability projection keeps estimate, actual, and payment evidence separate'

update public.jobs
set status = 'invoiced',
    updated_at = now(),
    version = version + 1
where id = '10000000-0000-4000-8000-000000000631';

update public.invoices
set status = 'open',
    amount_paid = 132.00,
    balance_due = 396.00,
    sent_at = now(),
    updated_at = now(),
    version = version + 1
where id = '10000000-0000-4000-8000-000000000651';

insert into public.job_actual_cost_snapshots (
  id,
  company_id,
  job_id,
  actual_material_cost,
  actual_labor_cost,
  actual_other_direct_cost,
  material_cost_complete,
  labor_cost_complete,
  other_direct_cost_complete,
  source_record_ids,
  as_of,
  verified_at,
  verified_by
)
values (
  '21000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000631',
  50.00,
  80.00,
  5.00,
  true,
  true,
  true,
  array[
    '10000000-0000-4000-8000-000000000641',
    '10000000-0000-4000-8000-000000000655'
  ]::uuid[],
  now() - interval '1 minute',
  now(),
  '10000000-0000-4000-8000-000000000101'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  projection jsonb;
  expected_estimated_margin text;
  expected_actual_margin text;
begin
  projection := public.get_storyops_profitability_kpis(
    '10000000-0000-4000-8000-000000000001'
  );
  expected_estimated_margin := round(
    (487.76::numeric - 188.51::numeric) / 487.76::numeric * 100,
    4
  )::text;
  expected_actual_margin := round(
    (487.76::numeric - 135.00::numeric) / 487.76::numeric * 100,
    4
  )::text;

  if projection ->> 'schemaVersion'
      <> 'storyops-profitability-kpis-v1'
    or projection ->> 'companyId'
      <> '10000000-0000-4000-8000-000000000001'
    or projection ->> 'currency' <> 'USD'
    or projection #>> '{scope,revenueBasis}'
      <> 'invoice_subtotal_excluding_tax'
    or projection #>> '{scope,actualCostBasis}'
      <> 'explicit_verified_job_actual_cost_snapshot'
    or projection #>> '{jobs,eligibleCount}' <> '1'
    or projection #>> '{jobs,profitabilityCount}' <> '1'
    or projection #>> '{revenue,invoicedSubtotal}' <> '487.76'
    or projection #>> '{revenue,invoicedTax}' <> '40.24'
    or projection #>> '{costs,estimatedInvoicedJobs}' <> '188.51'
    or projection #>> '{costs,recordedActualMaterial}' <> '50.00'
    or projection #>> '{costs,recordedActualLabor}' <> '80.00'
    or projection #>> '{costs,recordedActualOtherDirect}' <> '5.00'
    or projection #>> '{costs,actualTotal}' <> '135.00'
    or projection #>> '{profitability,estimatedGrossProfit}' <> '299.25'
    or projection #>> '{profitability,estimatedGrossMarginPercent}'
      <> expected_estimated_margin
    or projection #>> '{profitability,actualGrossProfit}' <> '352.76'
    or projection #>> '{profitability,actualGrossMarginPercent}'
      <> expected_actual_margin
    or projection #>> '{receivables,recordedPaid}' <> '132.00'
    or projection #>> '{receivables,providerVerifiedPaid}' <> '132.00'
    or projection #>> '{receivables,openBalance}' <> '396.00'
    or projection #>> '{receivables,pendingRefundAmount}' <> '0.00'
    or projection #>> '{completeness,complete}' <> 'true'
    or projection #>> '{completeness,actualCosts,complete}' <> 'true'
    or projection #>> '{completeness,actualCosts,completeJobCount}' <> '1'
    or projection #>> '{completeness,paymentEvidenceComplete}' <> 'true'
    or jsonb_array_length(projection #> '{completeness,unknowns}') <> 0
    or projection #>> '{evidence,sourceFingerprint}' !~ '^[a-f0-9]{64}$'
    or not (
      projection #> '{evidence,sourceIds,jobIds}'
      @> '["10000000-0000-4000-8000-000000000631"]'::jsonb
    )
    or not (
      projection #> '{evidence,sourceIds,invoiceIds}'
      @> '["10000000-0000-4000-8000-000000000651"]'::jsonb
    )
    or not (
      projection #> '{evidence,sourceIds,costSnapshotIds}'
      @> '["21000000-0000-4000-8000-000000000001"]'::jsonb
    )
    or not (
      projection #> '{evidence,sourceIds,paymentIds}'
      @> '["10000000-0000-4000-8000-000000000655"]'::jsonb
    )
    or not (
      projection #> '{evidence,sourceIds,providerEventIds}'
      @> '["10000000-0000-4000-8000-000000000656"]'::jsonb
    )
  then
    raise exception 'Complete profitability projection is incorrect: %', projection;
  end if;
end;
$$;

\echo '2/6 owner and dispatcher RLS can read exact tenant cost snapshots'
do $$
begin
  if has_table_privilege(
      'authenticated',
      'public.job_actual_cost_snapshots',
      'INSERT'
    )
    or has_table_privilege(
      'authenticated',
      'public.job_actual_cost_snapshots',
      'UPDATE'
    )
    or has_table_privilege(
      'authenticated',
      'public.job_actual_cost_snapshots',
      'DELETE'
    )
    or has_table_privilege(
      'service_role',
      'public.job_actual_cost_snapshots',
      'DELETE'
    )
  then
    raise exception 'Actual-cost snapshots retain a destructive browser or service grant';
  end if;
  if (
    select count(*)
    from public.job_actual_cost_snapshots
    where company_id = '10000000-0000-4000-8000-000000000001'
  ) <> 1 then
    raise exception 'Owner RLS did not expose the exact company cost snapshot';
  end if;
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000102',
  true
);
do $$
declare
  projection jsonb;
begin
  projection := public.get_storyops_profitability_kpis(
    '10000000-0000-4000-8000-000000000001'
  );
  if projection #>> '{profitability,actualGrossProfit}' <> '352.76'
    or (
      select count(*)
      from public.job_actual_cost_snapshots
      where company_id = '10000000-0000-4000-8000-000000000001'
    ) <> 1
  then
    raise exception 'Dispatcher finance read scope is incomplete';
  end if;
end;
$$;
reset role;

\echo '3/6 technician and customer cannot read profitability through RPC or RLS'
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000103',
  true
);
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.get_storyops_profitability_kpis(
      '10000000-0000-4000-8000-000000000001'
    );
  exception when others then
    denied := sqlerrm = 'Profitability KPIs require active owner or dispatcher membership';
  end;
  if not denied or exists (
    select 1 from public.job_actual_cost_snapshots
  ) then
    raise exception 'Technician retained profitability RPC or cost snapshot access';
  end if;
end;
$$;
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.get_storyops_profitability_kpis(
      '10000000-0000-4000-8000-000000000001'
    );
  exception when others then
    denied := sqlerrm = 'Profitability KPIs require active owner or dispatcher membership';
  end;
  if not denied or exists (
    select 1 from public.job_actual_cost_snapshots
  ) then
    raise exception 'Customer retained profitability RPC or cost snapshot access';
  end if;
end;
$$;
reset role;

\echo '4/6 active owner membership cannot cross a company boundary'
insert into public.companies (id, name, timezone)
values (
  '21000000-0000-4000-8000-000000000099',
  'Profitability Isolation Company',
  'America/Chicago'
);

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.get_storyops_profitability_kpis(
      '21000000-0000-4000-8000-000000000099'
    );
  exception when others then
    denied := sqlerrm = 'Profitability KPIs require active owner or dispatcher membership';
  end;
  if not denied then
    raise exception 'Owner crossed the company profitability boundary';
  end if;
end;
$$;
reset role;

\echo '5/6 incomplete actual costs retain recorded facts but withhold actual profit'
update public.job_actual_cost_snapshots
set actual_labor_cost = null,
    labor_cost_complete = false,
    updated_at = now(),
    version = version + 1
where id = '21000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  projection jsonb;
begin
  projection := public.get_storyops_profitability_kpis(
    '10000000-0000-4000-8000-000000000001'
  );
  if projection #>> '{costs,recordedActualMaterial}' <> '50.00'
    or projection #> '{costs,recordedActualLabor}' <> 'null'::jsonb
    or projection #> '{costs,actualTotal}' <> 'null'::jsonb
    or projection #> '{profitability,actualGrossProfit}' <> 'null'::jsonb
    or projection #> '{profitability,actualGrossMarginPercent}' <> 'null'::jsonb
    or projection #>> '{completeness,actualCosts,complete}' <> 'false'
    or projection #>> '{completeness,actualCosts,completeJobCount}' <> '0'
    or not exists (
      select 1
      from jsonb_array_elements_text(
        projection #> '{completeness,unknowns}'
      ) unknown
      where unknown like 'Actual labor cost is incomplete%'
    )
  then
    raise exception 'Incomplete actual cost was inferred or hidden: %', projection;
  end if;
end;
$$;
reset role;

\echo '6/6 unmatched recorded paid dollars never become provider-verified truth'
update public.invoices
set amount_paid = 133.00,
    balance_due = 395.00,
    updated_at = now(),
    version = version + 1
where id = '10000000-0000-4000-8000-000000000651';

set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  projection jsonb;
begin
  projection := public.get_storyops_profitability_kpis(
    '10000000-0000-4000-8000-000000000001'
  );
  if projection #>> '{receivables,recordedPaid}' <> '133.00'
    or projection #>> '{receivables,providerVerifiedPaid}' <> '0.00'
    or projection #>> '{completeness,paymentEvidenceComplete}' <> 'false'
    or projection #>> '{completeness,paymentEvidenceGapCount}' <> '1'
    or not exists (
      select 1
      from jsonb_array_elements_text(
        projection #> '{completeness,unknowns}'
      ) unknown
      where unknown like '%not fully matched to processed Stripe evidence%'
    )
  then
    raise exception 'Unmatched paid amount was presented as verified: %', projection;
  end if;
end;
$$;
reset role;

rollback;

\echo 'Live profitability KPI contract passed.'
