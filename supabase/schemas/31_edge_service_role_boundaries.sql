-- Restore Edge runtime access without restoring generic service-role table ACLs.
--
-- Every function in this migration is a finite, company-scoped projection or
-- command. Callers must present the service-role JWT and, where a user caused
-- the operation, an active company member. Base tables remain unavailable to
-- service_role through PostgREST.

revoke select, insert, update, delete, truncate, references, trigger
  on all tables in schema public
  from service_role;
alter default privileges in schema public
  revoke select, insert, update, delete, truncate, references, trigger
  on tables
  from service_role;

create or replace function private.assert_storyops_edge_actor(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_allowed_roles text[]
)
returns public.app_role
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_role public.app_role;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'EDGE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_company_id is null
    or p_actor_user_id is null
    or p_allowed_roles is null
    or cardinality(p_allowed_roles) < 1
    or cardinality(p_allowed_roles) > 4
    or p_allowed_roles <@ array['owner', 'dispatcher', 'technician', 'customer']::text[] is false
  then
    raise exception using message = 'EDGE_ACTOR_INPUT_INVALID';
  end if;

  select membership.role
  into actor_role
  from public.company_memberships membership
  join public.companies company
    on company.id = membership.company_id
   and company.status = 'active'
  where membership.company_id = p_company_id
    and membership.user_id = p_actor_user_id
    and membership.active
    and membership.role::text = any(p_allowed_roles);

  if actor_role is null then
    raise exception using message = 'EDGE_ACTOR_FORBIDDEN';
  end if;
  return actor_role;
end;
$$;

revoke all on function private.assert_storyops_edge_actor(uuid, uuid, text[])
  from public, anon, authenticated, service_role;

create or replace function public.load_storyops_edge_actor(
  p_company_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_role public.app_role;
begin
  actor_role := private.assert_storyops_edge_actor(
    p_company_id,
    p_actor_user_id,
    array['owner', 'dispatcher', 'technician']
  );
  return jsonb_build_object(
    'company_id', p_company_id,
    'user_id', p_actor_user_id,
    'role', actor_role,
    'active', true
  );
end;
$$;

revoke all on function public.load_storyops_edge_actor(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_edge_actor(uuid, uuid)
  to service_role;

create or replace function public.load_storyops_ai_fact_rows(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_table text,
  p_field text,
  p_values uuid[],
  p_limit integer default 51
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  result jsonb;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id,
    p_actor_user_id,
    array['owner', 'dispatcher']
  );
  if p_values is null
    or cardinality(p_values) < 1
    or cardinality(p_values) > 50
    or p_limit not between 1 and 51
  then
    raise exception using message = 'AI_FACT_SCOPE_INVALID';
  end if;

  case p_table
    when 'leads' then
      if p_field not in ('id', 'customer_id', 'property_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, status, source, customer_id, property_id, requested_services,
               preferred_contact_channel, updated_at, version
        from public.leads
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'customer_id' then customer_id = any(p_values)
            when 'property_id' then property_id = any(p_values)
          end
        order by id
        limit p_limit
      ) fact;
    when 'customers' then
      if p_field <> 'id' then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, lifecycle, do_not_contact, tax_exempt, updated_at, version
        from public.customers
        where company_id = p_company_id and id = any(p_values)
        order by id limit p_limit
      ) fact;
    when 'properties' then
      if p_field not in ('id', 'customer_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, customer_id, property_type, known_hazards, stories,
               geocode_confidence, last_serviced_at, updated_at, version
        from public.properties
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'customer_id' then customer_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'property_measurements' then
      if p_field not in ('id', 'property_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, property_id, kind, label, value, unit, source, measured_at,
               confidence, verified_by_human, source_asset_ids, updated_at, version
        from public.property_measurements
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'property_id' then property_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'photo_analyses' then
      if p_field not in ('id', 'property_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, property_id, purpose, overall_confidence, unknowns, disposition,
               analyzed_at, injection_signals
        from public.photo_analyses
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'property_id' then property_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'price_books' then
      if p_field <> 'id' then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, version_label, status, effective_from, effective_until,
               company_minimum, default_tax_rate_pct, margin_floor_pct,
               automatic_discount_limit_pct, deposit_kind, deposit_value,
               updated_at, version
        from public.price_books
        where company_id = p_company_id and id = any(p_values)
        order by id limit p_limit
      ) fact;
    when 'estimates' then
      if p_field not in ('id', 'property_id', 'lead_id', 'customer_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, estimate_number, customer_id, property_id, lead_id, price_book_id,
               price_book_version, status, service_subtotal, travel_fee, discount,
               tax, total, deposit_required, estimated_cost, estimated_margin_pct,
               duration_minutes, calculation_version, calculation_issues,
               calculated_at, updated_at, version
        from public.estimates
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'property_id' then property_id = any(p_values)
            when 'lead_id' then lead_id = any(p_values)
            when 'customer_id' then customer_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'estimate_lines' then
      if p_field not in ('id', 'estimate_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, estimate_id, line_kind, service_code, add_on_code, description,
               quantity, unit, unit_price, multiplier, subtotal, taxable,
               estimated_cost, source_measurement_ids, sort_order, created_at
        from public.estimate_lines
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'estimate_id' then estimate_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'quotes' then
      if p_field not in ('id', 'estimate_id', 'customer_id', 'property_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, quote_number, estimate_id, customer_id, property_id, status,
               valid_until, terms_version, total, deposit_required, sent_at,
               accepted_at, updated_at, version
        from public.quotes
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'estimate_id' then estimate_id = any(p_values)
            when 'customer_id' then customer_id = any(p_values)
            when 'property_id' then property_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'jobs' then
      if p_field not in ('id', 'quote_id', 'customer_id', 'property_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, job_number, quote_id, customer_id, property_id, status, priority,
               service_codes, estimated_duration_minutes, estimated_revenue,
               estimated_cost, assigned_crew_id, updated_at, version
        from public.jobs
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'quote_id' then quote_id = any(p_values)
            when 'customer_id' then customer_id = any(p_values)
            when 'property_id' then property_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'visits' then
      if p_field not in ('id', 'job_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, job_id, sequence, status, starts_at, ends_at, crew_id,
               route_check_id, weather_check_id, scheduling_evidence_receipt_id,
               updated_at, version
        from public.visits
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'job_id' then job_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'invoices' then
      if p_field not in ('id', 'customer_id', 'job_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, invoice_number, customer_id, job_id, status, issue_date, due_date,
               subtotal, tax, total, amount_paid, balance_due, paid_at, updated_at, version
        from public.invoices
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'customer_id' then customer_id = any(p_values)
            when 'job_id' then job_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'payments' then
      if p_field not in ('id', 'invoice_id', 'customer_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, invoice_id, customer_id, payment_type, status, processed_at,
               updated_at, version
        from public.payments
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'invoice_id' then invoice_id = any(p_values)
            when 'customer_id' then customer_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'consent_records' then
      if p_field not in ('id', 'lead_id', 'customer_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, customer_id, lead_id, channel, purpose, status, captured_at,
               capture_method, withdrawn_at, updated_at, version
        from public.consent_records
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'lead_id' then lead_id = any(p_values)
            when 'customer_id' then customer_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'incidents' then
      if p_field not in ('id', 'job_id', 'visit_id', 'property_id') then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, job_id, visit_id, property_id, severity, status, category,
               occurred_at, reported_at, owner_notified_at, requires_legal_review,
               closed_at, updated_at, version
        from public.incidents
        where company_id = p_company_id
          and case p_field
            when 'id' then id = any(p_values)
            when 'job_id' then job_id = any(p_values)
            when 'visit_id' then visit_id = any(p_values)
            when 'property_id' then property_id = any(p_values)
          end
        order by id limit p_limit
      ) fact;
    when 'scheduling_evidence_consumptions' then
      if p_field <> 'evidence_receipt_id' then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, company_id, evidence_receipt_id, visit_id, consumed_at
        from public.scheduling_evidence_consumptions
        where company_id = p_company_id and evidence_receipt_id = any(p_values)
        order by id limit p_limit
      ) fact;
    when 'route_checks' then
      if p_field <> 'id' then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, company_id, provider, route_feasible, violations
        from public.route_checks
        where company_id = p_company_id and id = any(p_values)
        order by id limit p_limit
      ) fact;
    when 'weather_checks' then
      if p_field <> 'id' then
        raise exception using message = 'AI_FACT_RELATIONSHIP_FORBIDDEN';
      end if;
      select coalesce(jsonb_agg(to_jsonb(fact) order by fact.id), '[]'::jsonb)
      into result
      from (
        select id, company_id, provider, forecast_issued_at, policy_disposition
        from public.weather_checks
        where company_id = p_company_id and id = any(p_values)
        order by id limit p_limit
      ) fact;
    else
      raise exception using message = 'AI_FACT_TABLE_FORBIDDEN';
  end case;
  return result;
end;
$$;

revoke all on function public.load_storyops_ai_fact_rows(
  uuid, uuid, text, text, uuid[], integer
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_ai_fact_rows(
  uuid, uuid, text, text, uuid[], integer
) to service_role;

create or replace function public.load_storyops_ai_active_price_book(
  p_company_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  result jsonb;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  select to_jsonb(fact)
  into result
  from (
    select id, version_label, status, effective_from, effective_until,
           company_minimum, default_tax_rate_pct, margin_floor_pct,
           automatic_discount_limit_pct, deposit_kind, deposit_value,
           updated_at, version
    from public.price_books
    where company_id = p_company_id and status = 'active'
    order by effective_from desc, id
    limit 1
  ) fact;
  return case
    when result is null then '[]'::jsonb
    else jsonb_build_array(result)
  end;
end;
$$;

revoke all on function public.load_storyops_ai_active_price_book(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_ai_active_price_book(uuid, uuid)
  to service_role;

create or replace function public.load_storyops_ai_scheduling_receipts(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_field text,
  p_values uuid[],
  p_limit integer default 11
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  result jsonb;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  if p_field not in ('id', 'job_id')
    or p_values is null
    or cardinality(p_values) < 1
    or cardinality(p_values) > 50
    or p_limit not between 1 and 11
  then
    raise exception using message = 'AI_SCHEDULING_RECEIPT_SCOPE_INVALID';
  end if;
  select coalesce(jsonb_agg(to_jsonb(fact) order by fact.created_at desc), '[]'::jsonb)
  into result
  from (
    select id, company_id, job_id, property_id, crew_id, starts_at, ends_at,
           evidence_mode, capacity_provider, capacity_reference,
           capacity_disposition, capacity_observed_at, capacity_expires_at,
           capacity_payload, route_check_id, route_disposition, route_observed_at,
           route_expires_at, weather_check_id, weather_disposition,
           weather_observed_at, weather_expires_at, weather_policy_version,
           unknowns, conflicts, expires_at, created_at
    from public.scheduling_evidence_receipts
    where company_id = p_company_id
      and case p_field
        when 'id' then id = any(p_values)
        when 'job_id' then job_id = any(p_values)
      end
    order by created_at desc, id
    limit p_limit
  ) fact;
  return result;
end;
$$;

revoke all on function public.load_storyops_ai_scheduling_receipts(
  uuid, uuid, text, uuid[], integer
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_ai_scheduling_receipts(
  uuid, uuid, text, uuid[], integer
) to service_role;

create or replace function public.load_storyops_ai_owner_briefing_rows(
  p_company_id uuid,
  p_actor_user_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  return jsonb_build_object(
    'leads', (
      select coalesce(jsonb_agg(to_jsonb(row_value)), '[]'::jsonb)
      from (
        select status from public.leads
        where company_id = p_company_id order by status limit 1001
      ) row_value
    ),
    'jobs', (
      select coalesce(jsonb_agg(to_jsonb(row_value)), '[]'::jsonb)
      from (
        select status from public.jobs
        where company_id = p_company_id order by status limit 1001
      ) row_value
    ),
    'invoices', (
      select coalesce(jsonb_agg(to_jsonb(row_value)), '[]'::jsonb)
      from (
        select status, balance_due, due_date from public.invoices
        where company_id = p_company_id order by status limit 1001
      ) row_value
    ),
    'approvals', (
      select coalesce(jsonb_agg(to_jsonb(row_value)), '[]'::jsonb)
      from (
        select status, risk_level from public.approval_requests
        where company_id = p_company_id order by status limit 1001
      ) row_value
    )
  );
end;
$$;

revoke all on function public.load_storyops_ai_owner_briefing_rows(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_ai_owner_briefing_rows(uuid, uuid)
  to service_role;

create or replace function public.load_storyops_ai_metrics(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_metric_set text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  result jsonb;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  if p_metric_set = 'pipeline' then
    select jsonb_build_object(
      'metrics', jsonb_build_object(
        'leadsByStatus',
        coalesce(jsonb_object_agg(status, total), '{}'::jsonb)
      ),
      'unknowns', '[]'::jsonb
    )
    into result
    from (
      select allowed.status, count(lead.id)::integer total
      from unnest(array[
        'new', 'qualifying', 'qualified', 'unqualified', 'converted', 'lost'
      ]::text[]) allowed(status)
      left join public.leads lead
        on lead.company_id = p_company_id and lead.status = allowed.status
      group by allowed.status
    ) counts;
  elsif p_metric_set = 'operations' then
    select jsonb_build_object(
      'metrics', jsonb_build_object(
        'jobsByStatus', (
          select coalesce(jsonb_object_agg(status, total), '{}'::jsonb)
          from (
            select allowed.status, count(job.id)::integer total
            from unnest(array[
              'pending_deposit', 'ready_to_schedule', 'scheduled', 'in_progress',
              'completed', 'invoiced', 'cancelled'
            ]::text[]) allowed(status)
            left join public.jobs job
              on job.company_id = p_company_id and job.status = allowed.status
            group by allowed.status
          ) values_by_status
        ),
        'visitsByStatus', (
          select coalesce(jsonb_object_agg(status, total), '{}'::jsonb)
          from (
            select allowed.status, count(visit.id)::integer total
            from unnest(array[
              'planned', 'confirmed', 'en_route', 'on_site', 'paused',
              'completed', 'cancelled', 'weather_hold'
            ]::text[]) allowed(status)
            left join public.visits visit
              on visit.company_id = p_company_id and visit.status = allowed.status
            group by allowed.status
          ) values_by_status
        )
      ),
      'unknowns', '[]'::jsonb
    ) into result;
  elsif p_metric_set = 'finance' then
    select jsonb_build_object(
      'metrics', jsonb_build_object(
        'invoicesByStatus', (
          select coalesce(jsonb_object_agg(status, total), '{}'::jsonb)
          from (
            select allowed.status, count(invoice.id)::integer total
            from unnest(array[
              'draft', 'open', 'paid', 'past_due', 'void', 'uncollectible'
            ]::text[]) allowed(status)
            left join public.invoices invoice
              on invoice.company_id = p_company_id and invoice.status = allowed.status
            group by allowed.status
          ) values_by_status
        ),
        'paymentsByStatus', (
          select coalesce(jsonb_object_agg(status, total), '{}'::jsonb)
          from (
            select allowed.status, count(payment.id)::integer total
            from unnest(array[
              'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'
            ]::text[]) allowed(status)
            left join public.payments payment
              on payment.company_id = p_company_id and payment.status = allowed.status
            group by allowed.status
          ) values_by_status
        )
      ),
      'unknowns', '[]'::jsonb
    ) into result;
  else
    raise exception using message = 'AI_METRIC_SET_FORBIDDEN';
  end if;
  return result;
end;
$$;

revoke all on function public.load_storyops_ai_metrics(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_ai_metrics(uuid, uuid, text)
  to service_role;

create or replace function public.load_storyops_ai_record(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_agent text,
  p_subject_type text,
  p_subject_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  allowed_subjects text[];
  result jsonb;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  if p_subject_id is null then
    raise exception using message = 'AI_RECORD_SCOPE_INVALID';
  end if;
  allowed_subjects := case p_agent
    when 'intake' then array['lead', 'customer']
    when 'estimating' then array['lead', 'customer', 'property', 'estimate', 'quote']
    when 'scheduling' then array['property', 'job', 'visit']
    when 'follow_up' then array['lead', 'customer', 'quote', 'job', 'invoice']
    when 'marketing' then array['customer', 'job', 'review']
    when 'finance' then array['customer', 'quote', 'job', 'invoice', 'payment']
    when 'safety' then array['property', 'job', 'visit', 'incident']
    when 'owner_briefing' then array[
      'lead', 'customer', 'property', 'estimate', 'quote', 'job', 'visit',
      'invoice', 'payment', 'incident', 'review', 'approval'
    ]
    else null
  end;
  if allowed_subjects is null or not p_subject_type = any(allowed_subjects) then
    raise exception using message = 'AI_RECORD_SUBJECT_FORBIDDEN';
  end if;

  case p_subject_type
    when 'lead' then
      select to_jsonb(row_value) into result from (
        select id, status, source, requested_services, preferred_contact_channel,
               customer_id, property_id, updated_at, version
        from public.leads where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'customer' then
      select to_jsonb(row_value) into result from (
        select id, lifecycle, do_not_contact, tax_exempt, updated_at, version
        from public.customers where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'property' then
      select to_jsonb(row_value) into result from (
        select id, customer_id, property_type, stories, geocoded_at,
               last_serviced_at, known_hazards, updated_at, version
        from public.properties where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'estimate' then
      select to_jsonb(row_value) into result from (
        select id, customer_id, property_id, lead_id, price_book_id,
               price_book_version, status, total, deposit_required,
               estimated_margin_pct, duration_minutes, calculated_at, updated_at, version
        from public.estimates where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'quote' then
      select to_jsonb(row_value) into result from (
        select id, estimate_id, customer_id, property_id, status, valid_until,
               total, deposit_required, sent_at, accepted_at, updated_at, version
        from public.quotes where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'job' then
      select to_jsonb(row_value) into result from (
        select id, quote_id, customer_id, property_id, status, priority, service_codes,
               estimated_duration_minutes, estimated_revenue, estimated_cost,
               assigned_crew_id, updated_at, version
        from public.jobs where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'visit' then
      select to_jsonb(row_value) into result from (
        select id, job_id, status, starts_at, ends_at, crew_id, route_check_id,
               weather_check_id, offline_revision, last_synced_at, updated_at, version
        from public.visits where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'invoice' then
      select to_jsonb(row_value) into result from (
        select id, customer_id, job_id, status, issue_date, due_date, subtotal,
               tax, total, amount_paid, balance_due, sent_at, paid_at, updated_at, version
        from public.invoices where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'payment' then
      select to_jsonb(row_value) into result from (
        select id, invoice_id, customer_id, payment_type, status, amount,
               processed_at, updated_at, version
        from public.payments where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'incident' then
      select to_jsonb(row_value) into result from (
        select id, job_id, visit_id, property_id, severity, status, category,
               occurred_at, reported_at, owner_notified_at, requires_legal_review,
               closed_at, updated_at, version
        from public.incidents where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'review' then
      select to_jsonb(row_value) into result from (
        select id, customer_id, job_id, provider, rating, received_at, sentiment,
               response_status, approval_request_id, updated_at, version
        from public.reviews where company_id = p_company_id and id = p_subject_id
      ) row_value;
    when 'approval' then
      select to_jsonb(row_value) into result from (
        select id, reason, risk_level, status, requested_at, expires_at, entity_type,
               entity_id, action_type, decided_at, consumed_at, updated_at, version
        from public.approval_requests
        where company_id = p_company_id and id = p_subject_id
      ) row_value;
    else
      raise exception using message = 'AI_RECORD_SUBJECT_FORBIDDEN';
  end case;
  return result;
end;
$$;

revoke all on function public.load_storyops_ai_record(uuid, uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_ai_record(uuid, uuid, text, text, uuid)
  to service_role;

create or replace function public.load_storyops_ai_service_codes(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_codes text[]
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  result jsonb;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  if p_codes is null
    or cardinality(p_codes) < 1
    or cardinality(p_codes) > 12
    or exists (
      select 1 from unnest(p_codes) code
      where code !~ '^[a-z0-9][a-z0-9_-]{0,79}$'
    )
  then
    raise exception using message = 'AI_SERVICE_CODES_INVALID';
  end if;
  select coalesce(jsonb_agg(code order by code), '[]'::jsonb)
  into result
  from (
    select catalog.code
    from public.service_catalog catalog
    where catalog.company_id = p_company_id
      and catalog.active
      and catalog.code = any(p_codes)
  ) active_codes;
  return result;
end;
$$;

revoke all on function public.load_storyops_ai_service_codes(uuid, uuid, text[])
  from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_ai_service_codes(uuid, uuid, text[])
  to service_role;

create or replace function public.load_storyops_ai_approval(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_approval_id uuid
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  result jsonb;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  select to_jsonb(row_value)
  into result
  from (
    select id, company_id, reason, risk_level, status, requested_by_type,
           requested_by_id, requested_at, expires_at, entity_type, entity_id,
           action_type, action_payload, summary, policy_version, decided_by,
           decided_at, decision_note, consumed_at, created_at, updated_at, version
    from public.approval_requests
    where company_id = p_company_id and id = p_approval_id
  ) row_value;
  return result;
end;
$$;

revoke all on function public.load_storyops_ai_approval(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_ai_approval(uuid, uuid, uuid)
  to service_role;

create or replace function public.create_storyops_ai_approval(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_approval_id uuid,
  p_reason text,
  p_risk_level text,
  p_requested_by_type text,
  p_requested_by_id text,
  p_requested_at timestamptz,
  p_expires_at timestamptz,
  p_action_type text,
  p_action_payload jsonb,
  p_summary text,
  p_policy_version text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  saved public.approval_requests%rowtype;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  if p_approval_id is null
    or p_reason not in (
      'price_exception', 'large_discount', 'margin_below_floor', 'refund', 'legal_message',
      'safety_message', 'negative_review_response', 'vendor_action',
      'bank_action', 'destructive_change', 'outside_price_book', 'outside_sop',
      'uncertain_scope', 'stale_availability', 'weather_exception',
      'campaign_send', 'other'
    )
    or p_risk_level not in ('low', 'medium', 'high', 'critical')
    or p_requested_by_type not in ('user', 'system')
    or (
      (p_requested_by_type = 'user' and p_requested_by_id <> p_actor_user_id::text)
      or (p_requested_by_type = 'system' and p_requested_by_id <> 'storyops-ai-office')
    )
    or p_requested_at is null
    or p_requested_at < now() - interval '10 minutes'
    or p_requested_at > now() + interval '2 minutes'
    or p_expires_at is null
    or p_expires_at <= p_requested_at
    or p_expires_at > p_requested_at + interval '30 days'
    or p_action_type !~ '^[a-z][a-z0-9_.-]{2,119}$'
    or p_action_payload is null
    or jsonb_typeof(p_action_payload) <> 'object'
    or (p_action_payload - array[
      'exactPayload', 'payloadHash', 'runId', 'actionId', 'toolName'
    ]) <> '{}'::jsonb
    or jsonb_typeof(p_action_payload -> 'exactPayload') <> 'object'
    or coalesce(p_action_payload ->> 'payloadHash', '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_action_payload ->> 'runId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or coalesce(p_action_payload ->> 'actionId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_action_payload ->> 'toolName' <> p_action_type
    or octet_length(p_action_payload::text) > 65536
    or length(coalesce(p_summary, '')) not between 1 and 2000
    or length(coalesce(p_policy_version, '')) not between 1 and 160
  then
    raise exception using message = 'AI_APPROVAL_INVALID';
  end if;

  insert into public.approval_requests(
    id, company_id, reason, risk_level, status, requested_by_type,
    requested_by_id, requested_at, expires_at, entity_type, entity_id,
    action_type, action_payload, summary, policy_version
  )
  values (
    p_approval_id, p_company_id, p_reason, p_risk_level, 'pending',
    p_requested_by_type, p_requested_by_id, p_requested_at, p_expires_at,
    'ai_action', null, p_action_type, p_action_payload, p_summary, p_policy_version
  )
  on conflict (id) do nothing;

  select * into saved
  from public.approval_requests
  where id = p_approval_id and company_id = p_company_id;
  if not found
    or saved.reason <> p_reason
    or saved.risk_level <> p_risk_level
    or saved.requested_by_type <> p_requested_by_type
    or saved.requested_by_id <> p_requested_by_id
    or saved.requested_at <> p_requested_at
    or saved.expires_at <> p_expires_at
    or saved.entity_type <> 'ai_action'
    or saved.entity_id is not null
    or saved.action_type <> p_action_type
    or saved.action_payload <> p_action_payload
    or saved.summary <> p_summary
    or saved.policy_version <> p_policy_version
  then
    raise exception using message = 'AI_APPROVAL_IDEMPOTENCY_CONFLICT';
  end if;
  return jsonb_build_object('approval_id', saved.id, 'status', saved.status);
end;
$$;

revoke all on function public.create_storyops_ai_approval(
  uuid, uuid, uuid, text, text, text, text, timestamptz, timestamptz,
  text, jsonb, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_storyops_ai_approval(
  uuid, uuid, uuid, text, text, text, text, timestamptz, timestamptz,
  text, jsonb, text, text
) to service_role;

create or replace function public.append_storyops_ai_trace(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_trace jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  trace_row_id uuid;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher', 'technician']
  );
  if p_trace is null
    or jsonb_typeof(p_trace) <> 'object'
    or (p_trace - array[
      'trace_id', 'span_id', 'agent', 'operation', 'status', 'model',
      'prompt_version', 'tool_name', 'started_at', 'ended_at',
      'input_redacted', 'output_redacted', 'guardrail_results', 'retain_until'
    ]) <> '{}'::jsonb
    or length(coalesce(p_trace ->> 'trace_id', '')) not between 1 and 200
    or coalesce(p_trace ->> 'span_id', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_trace ->> 'agent' not in (
      'intake', 'estimating', 'scheduling', 'follow_up', 'marketing',
      'finance', 'safety', 'briefing'
    )
    or length(coalesce(p_trace ->> 'operation', '')) not between 1 and 160
    or p_trace ->> 'status' not in (
      'started', 'succeeded', 'failed', 'approval_required', 'guardrail_blocked'
    )
    or length(coalesce(p_trace ->> 'prompt_version', '')) not between 1 and 160
    or jsonb_typeof(coalesce(p_trace -> 'input_redacted', '{}'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_trace -> 'output_redacted', '{}'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_trace -> 'guardrail_results', '{}'::jsonb)) <> 'object'
    or octet_length(p_trace::text) > 131072
    or (p_trace ->> 'started_at')::timestamptz < now() - interval '1 day'
    or (p_trace ->> 'started_at')::timestamptz > now() + interval '2 minutes'
    or (p_trace ->> 'retain_until')::timestamptz < now() + interval '1 day'
    or (p_trace ->> 'retain_until')::timestamptz > now() + interval '180 days'
  then
    raise exception using message = 'AI_TRACE_INVALID';
  end if;

  insert into public.ai_traces(
    company_id, trace_id, span_id, agent, operation, status, model,
    prompt_version, tool_name, started_at, ended_at, input_redacted,
    output_redacted, guardrail_results, retain_until
  )
  values (
    p_company_id,
    p_trace ->> 'trace_id',
    p_trace ->> 'span_id',
    p_trace ->> 'agent',
    p_trace ->> 'operation',
    p_trace ->> 'status',
    nullif(p_trace ->> 'model', ''),
    p_trace ->> 'prompt_version',
    nullif(p_trace ->> 'tool_name', ''),
    (p_trace ->> 'started_at')::timestamptz,
    nullif(p_trace ->> 'ended_at', '')::timestamptz,
    coalesce(p_trace -> 'input_redacted', '{}'::jsonb),
    coalesce(p_trace -> 'output_redacted', '{}'::jsonb),
    coalesce(p_trace -> 'guardrail_results', '{}'::jsonb),
    (p_trace ->> 'retain_until')::timestamptz
  )
  returning id into trace_row_id;
  return trace_row_id;
exception
  when invalid_text_representation or datetime_field_overflow then
    raise exception using message = 'AI_TRACE_INVALID';
end;
$$;

revoke all on function public.append_storyops_ai_trace(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.append_storyops_ai_trace(uuid, uuid, jsonb)
  to service_role;

create or replace function public.load_storyops_photo_analysis_asset(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_property_id uuid,
  p_asset_id uuid,
  p_purpose text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  actor_role public.app_role;
  asset_row public.media_assets%rowtype;
begin
  actor_role := private.assert_storyops_edge_actor(
    p_company_id,
    p_actor_user_id,
    array['owner', 'dispatcher', 'technician']
  );
  if p_property_id is null
    or p_asset_id is null
    or p_purpose not in ('scope', 'before', 'after', 'damage', 'safety', 'incident')
  then
    raise exception using message = 'PHOTO_ASSET_INPUT_INVALID';
  end if;

  select * into asset_row
  from public.media_assets asset
  where asset.id = p_asset_id
    and asset.company_id = p_company_id
    and asset.property_id = p_property_id;
  if not found then
    return null;
  end if;

  if actor_role = 'technician' and (
    asset_row.visit_id is null
    or not exists (
      select 1
      from public.visits visit
      join public.crews crew
        on crew.id = visit.crew_id
       and crew.company_id = visit.company_id
       and crew.active
      join public.crew_members crew_member
        on crew_member.crew_id = crew.id
       and crew_member.company_id = crew.company_id
       and crew_member.user_id = p_actor_user_id
       and crew_member.starts_on <= coalesce(visit.starts_at::date, current_date)
       and (
         crew_member.ends_on is null
         or crew_member.ends_on >= coalesce(visit.starts_at::date, current_date)
       )
      where visit.id = asset_row.visit_id
        and visit.company_id = p_company_id
        and visit.status <> 'cancelled'
    )
  ) then
    raise exception using message = 'PHOTO_ASSET_NOT_ASSIGNED';
  end if;

  return jsonb_build_object(
    'id', asset_row.id,
    'company_id', asset_row.company_id,
    'property_id', asset_row.property_id,
    'visit_id', asset_row.visit_id,
    'purpose', asset_row.purpose,
    'object_path', asset_row.object_path,
    'content_type', asset_row.content_type,
    'byte_size', asset_row.byte_size,
    'checksum_sha256', asset_row.checksum_sha256,
    'sync_state', asset_row.sync_state
  );
end;
$$;

revoke all on function public.load_storyops_photo_analysis_asset(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_photo_analysis_asset(
  uuid, uuid, uuid, uuid, text
) to service_role;

create or replace function public.persist_storyops_photo_analysis(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_property_id uuid,
  p_asset_id uuid,
  p_model text,
  p_prompt_version text,
  p_purpose text,
  p_analysis jsonb,
  p_analyzed_at timestamptz,
  p_retain_until timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, auth
as $$
declare
  asset jsonb;
  analysis_id uuid;
  disposition_value text;
  observations_value jsonb;
  measurements_value jsonb;
begin
  asset := public.load_storyops_photo_analysis_asset(
    p_company_id, p_actor_user_id, p_property_id, p_asset_id, p_purpose
  );
  if asset is null then
    raise exception using message = 'PHOTO_ASSET_NOT_FOUND';
  end if;
  if asset ->> 'purpose' <> p_purpose
    or asset ->> 'sync_state' <> 'synced'
    or asset ->> 'content_type' not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
    or (asset ->> 'byte_size')::bigint > (
      case when p_purpose = 'scope' then 10485760 else 26214400 end
    )
  then
    raise exception using message = 'PHOTO_ASSET_UNSUPPORTED';
  end if;
  if p_purpose = 'scope' and not public.authorize_scope_photo_analysis(
    p_company_id, p_actor_user_id, p_property_id, p_asset_id
  ) then
    raise exception using message = 'SCOPE_PHOTO_ANALYSIS_FORBIDDEN';
  end if;
  if length(coalesce(p_model, '')) not between 1 and 160
    or length(coalesce(p_prompt_version, '')) not between 1 and 160
    or p_analysis is null
    or jsonb_typeof(p_analysis) <> 'object'
    or (p_analysis - array[
      'overallConfidence', 'observations', 'measurementCandidates', 'accessFlags',
      'riskFlags', 'unknowns', 'injectionSignals', 'disposition', 'reasons'
    ]) <> '{}'::jsonb
    or jsonb_typeof(p_analysis -> 'observations') <> 'array'
    or jsonb_typeof(p_analysis -> 'measurementCandidates') <> 'array'
    or jsonb_typeof(p_analysis -> 'accessFlags') <> 'array'
    or jsonb_typeof(p_analysis -> 'riskFlags') <> 'array'
    or jsonb_typeof(p_analysis -> 'unknowns') <> 'array'
    or jsonb_typeof(p_analysis -> 'injectionSignals') <> 'array'
    or jsonb_typeof(p_analysis -> 'reasons') <> 'array'
    or jsonb_array_length(p_analysis -> 'observations') > 100
    or jsonb_array_length(p_analysis -> 'measurementCandidates') > 50
    or jsonb_array_length(p_analysis -> 'accessFlags') > 50
    or jsonb_array_length(p_analysis -> 'riskFlags') > 50
    or jsonb_array_length(p_analysis -> 'unknowns') > 100
    or jsonb_array_length(p_analysis -> 'injectionSignals') > 50
    or jsonb_array_length(p_analysis -> 'reasons') > 50
    or coalesce((p_analysis ->> 'overallConfidence')::numeric, -1) not between 0 and 1
    or p_analysis ->> 'disposition' not in (
      'usable_for_scope', 'human_review_required', 'insufficient'
    )
    or octet_length(p_analysis::text) > 131072
    or p_analyzed_at < now() - interval '10 minutes'
    or p_analyzed_at > now() + interval '2 minutes'
    or p_retain_until < now() + interval '1 day'
    or p_retain_until > now() + interval '180 days'
  then
    raise exception using message = 'PHOTO_ANALYSIS_INVALID';
  end if;

  select coalesce(
    jsonb_agg(observation || jsonb_build_object('sourceAssetId', p_asset_id)),
    '[]'::jsonb
  )
  into observations_value
  from jsonb_array_elements(p_analysis -> 'observations') observation;

  select coalesce(
    jsonb_agg(
      candidate || jsonb_build_object(
        'humanVerified', false,
        'sourceAssetIds', jsonb_build_array(p_asset_id)
      )
    ),
    '[]'::jsonb
  )
  into measurements_value
  from jsonb_array_elements(p_analysis -> 'measurementCandidates') candidate;

  disposition_value := p_analysis ->> 'disposition';
  insert into public.photo_analyses(
    company_id, property_id, source_asset_id, model, model_version,
    prompt_version, purpose, overall_confidence, observations,
    measurement_candidates, access_flags, risk_flags, unknowns,
    injection_signals, disposition, analyzed_at, retention_class, retain_until
  )
  values (
    p_company_id, p_property_id, p_asset_id, p_model, p_model,
    p_prompt_version, p_purpose, (p_analysis ->> 'overallConfidence')::numeric,
    observations_value, measurements_value, p_analysis -> 'accessFlags',
    p_analysis -> 'riskFlags',
    array(select jsonb_array_elements_text(p_analysis -> 'unknowns')),
    array(select jsonb_array_elements_text(p_analysis -> 'injectionSignals')),
    disposition_value, p_analyzed_at, 'ai_trace', p_retain_until
  )
  returning id into analysis_id;

  if p_purpose = 'scope' then
    perform public.link_scope_photo_analysis(p_company_id, p_asset_id, analysis_id);
  end if;

  insert into public.ai_traces(
    company_id, trace_id, span_id, agent, operation, status, model,
    prompt_version, tool_name, started_at, ended_at, input_redacted,
    output_redacted, guardrail_results, retain_until
  )
  values (
    p_company_id,
    'photo-' || analysis_id::text,
    gen_random_uuid()::text,
    'estimating',
    'photo.analyze',
    case when disposition_value = 'usable_for_scope'
      then 'succeeded' else 'guardrail_blocked' end,
    case when p_model = 'sandbox-photo-evidence' then 'sandbox' else p_model end,
    p_prompt_version,
    'photo.analyze',
    p_analyzed_at,
    p_analyzed_at,
    jsonb_build_object(
      'assetId', p_asset_id,
      'checksum', asset ->> 'checksum_sha256',
      'purpose', p_purpose
    ),
    jsonb_build_object(
      'analysisId', analysis_id,
      'disposition', disposition_value,
      'observationCount', jsonb_array_length(p_analysis -> 'observations'),
      'unknownCount', jsonb_array_length(p_analysis -> 'unknowns'),
      'accessFlagCount', jsonb_array_length(p_analysis -> 'accessFlags'),
      'riskFlagCount', jsonb_array_length(p_analysis -> 'riskFlags')
    ),
    jsonb_build_object(
      'reasons', p_analysis -> 'reasons',
      'billableMeasurementCount', 0
    ),
    p_retain_until
  );

  return jsonb_build_object('analysis_id', analysis_id);
exception
  when invalid_text_representation or numeric_value_out_of_range
    or datetime_field_overflow then
    raise exception using message = 'PHOTO_ANALYSIS_INVALID';
end;
$$;

revoke all on function public.persist_storyops_photo_analysis(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.persist_storyops_photo_analysis(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, timestamptz, timestamptz
) to service_role;

create or replace function public.load_storyops_billing_validation(
  p_company_id uuid,
  p_operation text,
  p_subject text,
  p_approval_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using message = 'EDGE_SERVICE_ROLE_REQUIRED';
  end if;
  if p_company_id is null
    or p_subject is null
    or length(p_subject) not between 1 and 255
    or not exists (
      select 1 from public.companies
      where id = p_company_id and status = 'active'
    )
  then
    raise exception using message = 'BILLING_VALIDATION_SCOPE_INVALID';
  end if;

  if p_operation = 'checkout' then
    if p_subject !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      raise exception using message = 'BILLING_VALIDATION_SCOPE_INVALID';
    end if;
    select to_jsonb(row_value) into result from (
      select id, customer_id, status, total, deposit_required, valid_until
      from public.quotes
      where company_id = p_company_id and id = p_subject::uuid
    ) row_value;
  elsif p_operation = 'invoice' then
    if p_subject !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      raise exception using message = 'BILLING_VALIDATION_SCOPE_INVALID';
    end if;
    select to_jsonb(row_value) into result from (
      select id, customer_id, status, due_date, total
      from public.invoices
      where company_id = p_company_id
        and job_id = p_subject::uuid
        and status in ('draft', 'open')
      order by created_at desc, id
      limit 1
    ) row_value;
  elsif p_operation = 'refund' then
    if p_approval_id is null
      or not exists (
        select 1
        from public.approval_requests approval
        where approval.id = p_approval_id
          and approval.company_id = p_company_id
          and approval.status = 'approved'
          and approval.action_type = 'payments.refund'
          and approval.entity_type = 'ai_action'
          and (approval.expires_at is null or approval.expires_at > now())
          and approval.action_payload -> 'exactPayload' ->> 'paymentProviderId' = p_subject
      )
    then
      raise exception using message = 'BILLING_REFUND_APPROVAL_INVALID';
    end if;
    select to_jsonb(row_value) into result from (
      select id, status, amount, provider_payment_id
      from public.payments
      where company_id = p_company_id
        and provider = 'stripe'
        and provider_payment_id = p_subject
    ) row_value;
  else
    raise exception using message = 'BILLING_OPERATION_FORBIDDEN';
  end if;
  return result;
end;
$$;

revoke all on function public.load_storyops_billing_validation(
  uuid, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_billing_validation(
  uuid, text, text, uuid
) to service_role;

create or replace function public.load_storyops_scheduling_reconciliation_state(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_job_id uuid,
  p_idempotency_key text,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  result jsonb;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  if p_job_id is null
    or length(coalesce(p_idempotency_key, '')) not between 8 and 256
    or p_now < now() - interval '2 minutes'
    or p_now > now() + interval '2 minutes'
  then
    raise exception using message = 'SCHEDULING_RECONCILIATION_SCOPE_INVALID';
  end if;

  select jsonb_build_object(
    'existing_receipt', (
      select to_jsonb(existing_receipt)
      from (
        select id, schema_version, company_id, job_id, job_version, property_id,
               crew_id, crew_version, starts_at, ends_at, evidence_mode,
               configuration_revision, operating_baseline_publication_id,
               capacity_disposition, route_disposition, weather_disposition,
               calendar_event_id, route_check_id, weather_check_id, unknowns,
               conflicts, expires_at, evidence_hash, request_hash, created_at
        from public.scheduling_evidence_receipts
        where company_id = p_company_id and idempotency_key = p_idempotency_key
      ) existing_receipt
    ),
    'stale_receipts', (
      select coalesce(jsonb_agg(to_jsonb(stale_receipt) order by stale_receipt.created_at), '[]'::jsonb)
      from (
        select receipt.id, receipt.capacity_reference, receipt.calendar_event_id,
               receipt.calendar_event_etag, receipt.idempotency_key,
               receipt.created_at,
               exists (
                 select 1 from public.scheduling_evidence_consumptions consumption
                 where consumption.company_id = p_company_id
                   and consumption.evidence_receipt_id = receipt.id
               ) consumed
        from public.scheduling_evidence_receipts receipt
        where receipt.company_id = p_company_id
          and receipt.job_id = p_job_id
          and receipt.evidence_mode = 'live'
          and receipt.capacity_disposition = 'eligible'
          and receipt.expires_at <= p_now
        order by receipt.created_at, receipt.id
        limit 21
      ) stale_receipt
    ),
    'has_other_active_unconsumed', exists (
      select 1
      from public.scheduling_evidence_receipts receipt
      where receipt.company_id = p_company_id
        and receipt.job_id = p_job_id
        and receipt.evidence_mode = 'live'
        and receipt.capacity_disposition = 'eligible'
        and receipt.expires_at > p_now
        and receipt.idempotency_key <> p_idempotency_key
        and not exists (
          select 1 from public.scheduling_evidence_consumptions consumption
          where consumption.company_id = p_company_id
            and consumption.evidence_receipt_id = receipt.id
        )
    )
  ) into result;
  return result;
end;
$$;

revoke all on function public.load_storyops_scheduling_reconciliation_state(
  uuid, uuid, uuid, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_scheduling_reconciliation_state(
  uuid, uuid, uuid, text, timestamptz
) to service_role;

create or replace function public.load_storyops_scheduling_candidate(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_job_id uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_crew_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
declare
  result jsonb;
  buffer_minutes integer := 0;
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  if p_job_id is null
    or p_window_start is null
    or p_window_end is null
    or p_window_end <= p_window_start
    or p_window_end > p_window_start + interval '24 hours'
  then
    raise exception using message = 'SCHEDULING_CANDIDATE_SCOPE_INVALID';
  end if;

  select case
    when configuration.configuration #>> '{schedule,appointmentBufferMinutes}' ~ '^[0-9]{1,4}$'
      then (configuration.configuration #>> '{schedule,appointmentBufferMinutes}')::integer
    else 0
  end
  into buffer_minutes
  from public.company_configuration_versions configuration
  where configuration.company_id = p_company_id
    and configuration.status = 'published'
    and configuration.publication_mode = 'live';

  select jsonb_build_object(
    'job', (
      select to_jsonb(row_value) from (
        select id, company_id, job_number, quote_id, property_id, status,
               service_codes, estimated_duration_minutes, version
        from public.jobs where company_id = p_company_id and id = p_job_id
      ) row_value
    ),
    'quote', (
      select to_jsonb(row_value) from (
        select quote.id, quote.company_id, quote.estimate_id, quote.status, quote.version
        from public.quotes quote
        join public.jobs job
          on job.quote_id = quote.id
         and job.company_id = quote.company_id
        where job.company_id = p_company_id and job.id = p_job_id
      ) row_value
    ),
    'property', (
      select to_jsonb(row_value) from (
        select property.id, property.company_id, property.service_address,
               property.latitude, property.longitude, property.geocode_confidence,
               property.geocoded_at, property.version,
               private.storyops_property_has_reviewed_geocode(
                 property.company_id,
                 property.id
               ) as reviewed_geocode
        from public.properties property
        join public.jobs job
          on job.property_id = property.id
         and job.company_id = property.company_id
        where job.company_id = p_company_id and job.id = p_job_id
      ) row_value
    ),
    'company', (
      select to_jsonb(row_value) from (
        select id, timezone, status, settings
        from public.companies where id = p_company_id
      ) row_value
    ),
    'configuration', (
      select to_jsonb(row_value) from (
        select id, revision, status, publication_mode, configuration,
               configuration_hash
        from public.company_configuration_versions
        where company_id = p_company_id
          and status = 'published'
          and publication_mode = 'live'
      ) row_value
    ),
    'estimate', (
      select to_jsonb(row_value) from (
        select estimate.id, estimate.company_id, estimate.duration_minutes,
               estimate.status, estimate.version
        from public.estimates estimate
        join public.quotes quote
          on quote.estimate_id = estimate.id
         and quote.company_id = estimate.company_id
        join public.jobs job
          on job.quote_id = quote.id
         and job.company_id = quote.company_id
        where job.company_id = p_company_id and job.id = p_job_id
      ) row_value
    ),
    'baseline', (
      select to_jsonb(row_value) from (
        select baseline.id, baseline.configuration_revision,
               baseline.baseline_hash, baseline.status
        from public.company_operating_baseline_publications baseline
        join public.company_configuration_versions configuration
          on configuration.company_id = baseline.company_id
         and configuration.revision = baseline.configuration_revision
         and configuration.status = 'published'
         and configuration.publication_mode = 'live'
        where baseline.company_id = p_company_id and baseline.status = 'active'
      ) row_value
    ),
    'catalog', (
      select coalesce(jsonb_agg(to_jsonb(row_value) order by row_value.code), '[]'::jsonb)
      from (
        select catalog.code, catalog.active, catalog.required_skills,
               catalog.required_equipment_types
        from public.service_catalog catalog
        join public.jobs job
          on catalog.code = any(job.service_codes)
         and catalog.company_id = job.company_id
        where job.company_id = p_company_id
          and job.id = p_job_id
          and catalog.active
        order by catalog.code
        limit 51
      ) row_value
    ),
    'crews', (
      select coalesce(jsonb_agg(to_jsonb(row_value) order by row_value.name, row_value.id), '[]'::jsonb)
      from (
        select id, company_id, name, active, skill_codes,
               home_base_postal_code, version
        from public.crews
        where company_id = p_company_id
          and active
          and (p_crew_id is null or id = p_crew_id)
        order by name, id
        limit 101
      ) row_value
    ),
    'crew_members', (
      select coalesce(jsonb_agg(to_jsonb(row_value)), '[]'::jsonb)
      from (
        select crew_id, user_id, starts_on, ends_on
        from public.crew_members
        where company_id = p_company_id
        order by crew_id, user_id
        limit 201
      ) row_value
    ),
    -- Retain the response key for compatibility; it now carries the complete
    -- canonical field-worker set (active owners and active technicians).
    'technician_memberships', (
      select coalesce(jsonb_agg(to_jsonb(row_value)), '[]'::jsonb)
      from (
        select user_id, role, active
        from public.company_memberships
        where company_id = p_company_id
          and active
          and role in ('owner', 'technician')
        order by user_id
        limit 201
      ) row_value
    ),
    'equipment', (
      select coalesce(jsonb_agg(to_jsonb(row_value)), '[]'::jsonb)
      from (
        select id, equipment_type, status, assigned_crew_id, next_inspection_due
        from public.equipment
        where company_id = p_company_id
        order by id
        limit 201
      ) row_value
    ),
    'equipment_reservations', (
      select coalesce(jsonb_agg(to_jsonb(row_value)), '[]'::jsonb)
      from (
        select equipment_id
        from public.scheduling_equipment_reservations
        where company_id = p_company_id
          and status in ('held', 'consumed')
          and starts_at < p_window_end
          and ends_at > p_window_start
        order by equipment_id
        limit 201
      ) row_value
    ),
    'visits', (
      select coalesce(jsonb_agg(to_jsonb(row_value)), '[]'::jsonb)
      from (
        select crew_id, starts_at, ends_at, status
        from public.visits
        where company_id = p_company_id
          and status <> 'cancelled'
          and starts_at < p_window_end + make_interval(mins => buffer_minutes)
          and ends_at > p_window_start - make_interval(mins => buffer_minutes)
        order by starts_at, id
        limit 201
      ) row_value
    )
  ) into result;

  if jsonb_array_length(result -> 'catalog') > 50
    or jsonb_array_length(result -> 'crews') > 100
    or jsonb_array_length(result -> 'crew_members') > 200
    or jsonb_array_length(result -> 'technician_memberships') > 200
    or jsonb_array_length(result -> 'equipment') > 200
    or jsonb_array_length(result -> 'equipment_reservations') > 200
    or jsonb_array_length(result -> 'visits') > 200
  then
    raise exception using message = 'SCHEDULING_CAPACITY_BOUND_EXCEEDED';
  end if;
  return result;
end;
$$;

revoke all on function public.load_storyops_scheduling_candidate(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_scheduling_candidate(
  uuid, uuid, uuid, timestamptz, timestamptz, uuid
) to service_role;

create or replace function public.load_storyops_scheduling_route_context(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_crew_id uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_limit integer default 51
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  if p_crew_id is null
    or p_window_end <= p_window_start
    or p_window_end > p_window_start + interval '24 hours'
    or p_limit not between 1 and 51
  then
    raise exception using message = 'SCHEDULING_ROUTE_SCOPE_INVALID';
  end if;

  return jsonb_build_object(
    'visits', (
      select coalesce(jsonb_agg(to_jsonb(row_value) order by row_value.starts_at, row_value.id), '[]'::jsonb)
      from (
        select id, job_id, status, starts_at, ends_at, version
        from public.visits
        where company_id = p_company_id
          and crew_id = p_crew_id
          and status <> 'cancelled'
          and starts_at < p_window_end
          and ends_at > p_window_start
        order by starts_at, id
        limit p_limit
      ) row_value
    ),
    'jobs', (
      select coalesce(jsonb_agg(to_jsonb(row_value) order by row_value.id), '[]'::jsonb)
      from (
        select distinct job.id, job.property_id, job.version
        from public.jobs job
        join public.visits visit
          on visit.job_id = job.id and visit.company_id = job.company_id
        where job.company_id = p_company_id
          and visit.crew_id = p_crew_id
          and visit.status <> 'cancelled'
          and visit.starts_at < p_window_end
          and visit.ends_at > p_window_start
        order by job.id
        limit p_limit
      ) row_value
    ),
    'properties', (
      select coalesce(jsonb_agg(to_jsonb(row_value) order by row_value.id), '[]'::jsonb)
      from (
        select distinct property.id, property.latitude, property.longitude,
               property.geocode_confidence, property.geocoded_at, property.version,
               private.storyops_property_has_reviewed_geocode(
                 property.company_id,
                 property.id
               ) as reviewed_geocode
        from public.properties property
        join public.jobs job
          on job.property_id = property.id and job.company_id = property.company_id
        join public.visits visit
          on visit.job_id = job.id and visit.company_id = job.company_id
        where property.company_id = p_company_id
          and visit.crew_id = p_crew_id
          and visit.status <> 'cancelled'
          and visit.starts_at < p_window_end
          and visit.ends_at > p_window_start
        order by property.id
        limit p_limit
      ) row_value
    )
  );
end;
$$;

revoke all on function public.load_storyops_scheduling_route_context(
  uuid, uuid, uuid, timestamptz, timestamptz, integer
) from public, anon, authenticated, service_role;
grant execute on function public.load_storyops_scheduling_route_context(
  uuid, uuid, uuid, timestamptz, timestamptz, integer
) to service_role;

create or replace function public.recheck_storyops_scheduling_capacity(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_job_id uuid,
  p_crew_id uuid,
  p_window_start timestamptz,
  p_window_end timestamptz
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private, auth
as $$
begin
  perform private.assert_storyops_edge_actor(
    p_company_id, p_actor_user_id, array['owner', 'dispatcher']
  );
  if p_job_id is null
    or p_crew_id is null
    or p_window_end <= p_window_start
    or p_window_end > p_window_start + interval '24 hours'
  then
    raise exception using message = 'SCHEDULING_RECHECK_SCOPE_INVALID';
  end if;
  return jsonb_build_object(
    'job', (
      select to_jsonb(row_value) from (
        select version, status
        from public.jobs where company_id = p_company_id and id = p_job_id
      ) row_value
    ),
    'conflicting_visit_ids', (
      select coalesce(jsonb_agg(id), '[]'::jsonb)
      from (
        select id
        from public.visits
        where company_id = p_company_id
          and crew_id = p_crew_id
          and status <> 'cancelled'
          and starts_at < p_window_end
          and ends_at > p_window_start
        order by id
        limit 1
      ) conflict
    )
  );
end;
$$;

revoke all on function public.recheck_storyops_scheduling_capacity(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.recheck_storyops_scheduling_capacity(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz
) to service_role;

-- Prove the boundary remains RPC-only even after future grant changes.
do $edge_acl_assertions$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'company_memberships', 'companies', 'leads', 'customers', 'properties',
    'property_measurements', 'photo_analyses', 'price_books', 'estimates',
    'estimate_lines', 'quotes', 'jobs', 'visits', 'invoices', 'payments',
    'consent_records', 'incidents', 'scheduling_evidence_receipts',
    'scheduling_evidence_consumptions', 'route_checks', 'weather_checks',
    'reviews', 'approval_requests', 'service_catalog', 'media_assets',
    'ai_traces', 'company_configuration_versions',
    'company_operating_baseline_publications', 'crews', 'crew_members',
    'equipment', 'scheduling_equipment_reservations', 'job_actual_cost_snapshots'
  ]
  loop
    if has_table_privilege(
      'service_role',
      format('public.%I', relation_name),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) then
      raise exception 'EDGE_SERVICE_ROLE_BASE_TABLE_PRIVILEGE:%', relation_name;
    end if;
  end loop;
end;
$edge_acl_assertions$;
