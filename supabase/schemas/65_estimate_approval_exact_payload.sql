-- Bind estimate-exception decisions to every blocking flag and the complete
-- deterministic estimate snapshot shown to the owner.

create or replace function private.storyops_estimate_blocker_risk(
  p_reason text
)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when p_reason in (
      'safety_message',
      'legal_message',
      'outside_sop',
      'destructive_change',
      'bank_action'
    ) then 'critical'
    when p_reason in (
      'price_exception',
      'large_discount',
      'margin_below_floor',
      'refund',
      'negative_review_response',
      'vendor_action',
      'outside_price_book',
      'uncertain_scope',
      'weather_exception'
    ) then 'high'
    else 'medium'
  end
$$;

revoke all on function private.storyops_estimate_blocker_risk(text)
  from public, anon, authenticated, service_role;

create or replace function private.storyops_risk_rank(
  p_risk text
)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select case p_risk
    when 'critical' then 4
    when 'high' then 3
    when 'medium' then 2
    when 'low' then 1
    else 0
  end
$$;

revoke all on function private.storyops_risk_rank(text)
  from public, anon, authenticated, service_role;

create or replace function private.build_estimate_approval_envelope(
  p_company_id uuid,
  p_legacy_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, extensions, private
as $$
declare
  blocking_flags jsonb;
  exact_payload jsonb;
  invalid_flag_count integer;
begin
  if p_company_id is null
    or jsonb_typeof(p_legacy_payload) <> 'object'
    or jsonb_typeof(p_legacy_payload -> 'snapshot') <> 'object'
    or jsonb_typeof(p_legacy_payload -> 'approvalFlags') <> 'array'
    or jsonb_array_length(p_legacy_payload -> 'approvalFlags') not between 1 and 32
    or coalesce(p_legacy_payload ->> 'estimateId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_legacy_payload ->> 'quoteId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_legacy_payload ->> 'intentHash', '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_legacy_payload ->> 'authoritativeSnapshotHash', '') !~ '^[a-f0-9]{64}$'
  then
    raise exception 'ESTIMATE_APPROVAL_LEGACY_PAYLOAD_INVALID';
  end if;

  select count(*)
  into invalid_flag_count
  from jsonb_array_elements(p_legacy_payload -> 'approvalFlags') flag
  where jsonb_typeof(flag) <> 'object'
    or flag ->> 'reason' not in (
      'price_exception', 'large_discount', 'margin_below_floor', 'refund',
      'legal_message', 'safety_message', 'negative_review_response',
      'vendor_action', 'bank_action', 'destructive_change',
      'outside_price_book', 'outside_sop', 'uncertain_scope',
      'stale_availability', 'weather_exception', 'campaign_send', 'other'
    )
    or jsonb_typeof(flag -> 'blocking') <> 'boolean'
    or jsonb_typeof(flag -> 'summary') <> 'string'
    or nullif(btrim(flag ->> 'summary'), '') is null
    or length(flag ->> 'summary') > 1000;
  if invalid_flag_count <> 0 then
    raise exception 'ESTIMATE_APPROVAL_FLAG_INVALID';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'reason', flag ->> 'reason',
      'riskLevel', private.storyops_estimate_blocker_risk(flag ->> 'reason'),
      'summary', btrim(flag ->> 'summary'),
      'blocking', true
    )
    order by
      flag ->> 'reason',
      btrim(flag ->> 'summary'),
      flag::text
  )
  into blocking_flags
  from jsonb_array_elements(p_legacy_payload -> 'approvalFlags') flag
  where (flag ->> 'blocking')::boolean;

  if blocking_flags is null or jsonb_array_length(blocking_flags) = 0 then
    raise exception 'ESTIMATE_APPROVAL_BLOCKER_REQUIRED';
  end if;

  if coalesce(p_legacy_payload #>> '{snapshot,priceBookId}', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_legacy_payload #>> '{snapshot,serviceTermsId}', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or nullif(p_legacy_payload #>> '{snapshot,priceBookVersion}', '') is null
    or nullif(p_legacy_payload #>> '{snapshot,termsVersion}', '') is null
    or nullif(p_legacy_payload #>> '{snapshot,calculationVersion}', '') is null
    or coalesce(p_legacy_payload #>> '{snapshot,total}', '') !~ '^-?[0-9]+(\.[0-9]+)?$'
    or coalesce(p_legacy_payload #>> '{snapshot,depositRequired}', '') !~
      '^-?[0-9]+(\.[0-9]+)?$'
    or coalesce(p_legacy_payload #>> '{snapshot,discount}', '') !~ '^-?[0-9]+(\.[0-9]+)?$'
    or coalesce(p_legacy_payload #>> '{snapshot,marginPercent}', '') !~
      '^-?[0-9]+(\.[0-9]+)?$'
  then
    raise exception 'ESTIMATE_APPROVAL_SNAPSHOT_INVALID';
  end if;

  exact_payload := jsonb_build_object(
    'schemaVersion', 'storyops-estimate-exception-exact-v1',
    'operation', 'estimate.approve_exception',
    'companyId', p_company_id,
    'estimateId', p_legacy_payload ->> 'estimateId',
    'quoteId', p_legacy_payload ->> 'quoteId',
    'intentHash', p_legacy_payload ->> 'intentHash',
    'authoritativeSnapshotHash',
      p_legacy_payload ->> 'authoritativeSnapshotHash',
    'snapshot', p_legacy_payload -> 'snapshot',
    'blockingFlags', blocking_flags
  );

  return jsonb_build_object(
    'schemaVersion', 'storyops-estimate-approval-envelope-v1',
    'payloadHash', encode(
      extensions.digest(exact_payload::text, 'sha256'),
      'hex'
    ),
    'exactPayload', exact_payload
  );
end;
$$;

revoke all on function private.build_estimate_approval_envelope(uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.storyops_estimate_envelope_risk(
  p_envelope jsonb
)
returns text
language sql
stable
set search_path = pg_catalog, private
as $$
  select flag ->> 'riskLevel'
  from jsonb_array_elements(p_envelope #> '{exactPayload,blockingFlags}') flag
  order by
    private.storyops_risk_rank(flag ->> 'riskLevel') desc,
    flag ->> 'reason',
    flag ->> 'summary'
  limit 1
$$;

revoke all on function private.storyops_estimate_envelope_risk(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.storyops_estimate_envelope_reason(
  p_envelope jsonb
)
returns text
language sql
stable
set search_path = pg_catalog, private
as $$
  select flag ->> 'reason'
  from jsonb_array_elements(p_envelope #> '{exactPayload,blockingFlags}') flag
  order by
    private.storyops_risk_rank(flag ->> 'riskLevel') desc,
    flag ->> 'reason',
    flag ->> 'summary'
  limit 1
$$;

revoke all on function private.storyops_estimate_envelope_reason(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.storyops_estimate_envelope_summary(
  p_envelope jsonb
)
returns text
language sql
stable
set search_path = pg_catalog
as $$
  select format(
    '%s blocking estimate exception%s require%s owner review of the exact payload.',
    jsonb_array_length(p_envelope #> '{exactPayload,blockingFlags}'),
    case
      when jsonb_array_length(p_envelope #> '{exactPayload,blockingFlags}') = 1
        then ''
      else 's'
    end,
    case
      when jsonb_array_length(p_envelope #> '{exactPayload,blockingFlags}') = 1
        then 's'
      else ''
    end
  )
$$;

revoke all on function private.storyops_estimate_envelope_summary(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.canonicalize_estimate_approval_request()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  envelope jsonb;
begin
  if new.action_type <> 'estimate.approve_exception' then
    return new;
  end if;
  envelope := private.build_estimate_approval_envelope(
    new.company_id,
    new.action_payload
  );
  new.action_payload := envelope;
  new.risk_level := private.storyops_estimate_envelope_risk(envelope);
  new.reason := private.storyops_estimate_envelope_reason(envelope);
  new.summary := private.storyops_estimate_envelope_summary(envelope);
  return new;
end;
$$;

revoke all on function public.canonicalize_estimate_approval_request()
  from public, anon, authenticated, service_role;

create trigger approval_requests_estimate_exact_payload
  before insert on public.approval_requests
  for each row execute function public.canonicalize_estimate_approval_request();

create or replace function public.apply_estimate_exception_decision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  exact_payload jsonb;
  blocking_flags jsonb;
  canonical_blocking_flags jsonb;
  canonical_exact_payload jsonb;
  estimate_id_value uuid;
  quote_id_value uuid;
  expected_snapshot jsonb;
  stored_payload_hash text;
  recomputed_payload_hash text;
  expected_risk text;
  expected_reason text;
  invalid_flag_count integer;
  affected_rows integer;
begin
  if old.status <> 'pending'
    or new.status not in ('approved', 'rejected', 'expired', 'cancelled')
    or new.action_type <> 'estimate.approve_exception'
  then
    return new;
  end if;

  exact_payload := new.action_payload -> 'exactPayload';
  blocking_flags := exact_payload -> 'blockingFlags';
  stored_payload_hash := new.action_payload ->> 'payloadHash';
  if new.action_payload ->> 'schemaVersion'
      <> 'storyops-estimate-approval-envelope-v1'
    or jsonb_typeof(exact_payload) <> 'object'
    or exact_payload ->> 'schemaVersion'
      <> 'storyops-estimate-exception-exact-v1'
    or exact_payload ->> 'operation' <> 'estimate.approve_exception'
    or exact_payload ->> 'companyId' <> new.company_id::text
    or jsonb_typeof(exact_payload -> 'snapshot') <> 'object'
    or jsonb_typeof(blocking_flags) <> 'array'
    or jsonb_array_length(blocking_flags) = 0
    or coalesce(stored_payload_hash, '') !~ '^[a-f0-9]{64}$'
    or coalesce(exact_payload ->> 'intentHash', '') !~ '^[a-f0-9]{64}$'
    or coalesce(exact_payload ->> 'authoritativeSnapshotHash', '')
      !~ '^[a-f0-9]{64}$'
    or coalesce(exact_payload ->> 'estimateId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(exact_payload ->> 'quoteId', '') !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    raise exception 'ESTIMATE_APPROVAL_EXACT_PAYLOAD_INVALID';
  end if;

  recomputed_payload_hash := encode(
    extensions.digest(exact_payload::text, 'sha256'),
    'hex'
  );
  if recomputed_payload_hash <> stored_payload_hash then
    raise exception 'ESTIMATE_APPROVAL_PAYLOAD_HASH_MISMATCH';
  end if;
  if new.action_payload <> jsonb_build_object(
    'schemaVersion', 'storyops-estimate-approval-envelope-v1',
    'payloadHash', stored_payload_hash,
    'exactPayload', exact_payload
  ) then
    raise exception 'ESTIMATE_APPROVAL_ENVELOPE_NOT_CANONICAL';
  end if;

  select count(*)
  into invalid_flag_count
  from jsonb_array_elements(blocking_flags) flag
  where jsonb_typeof(flag) <> 'object'
    or jsonb_typeof(flag -> 'blocking') <> 'boolean'
    or not (flag ->> 'blocking')::boolean
    or coalesce(flag ->> 'reason', '') not in (
      'price_exception', 'large_discount', 'margin_below_floor', 'refund',
      'legal_message', 'safety_message', 'negative_review_response',
      'vendor_action', 'bank_action', 'destructive_change',
      'outside_price_book', 'outside_sop', 'uncertain_scope',
      'stale_availability', 'weather_exception', 'campaign_send', 'other'
    )
    or coalesce(flag ->> 'riskLevel', '') not in (
      'low', 'medium', 'high', 'critical'
    )
    or flag ->> 'riskLevel'
      <> private.storyops_estimate_blocker_risk(flag ->> 'reason')
    or nullif(btrim(flag ->> 'summary'), '') is null;
  if invalid_flag_count <> 0 then
    raise exception 'ESTIMATE_APPROVAL_BLOCKERS_INVALID';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'reason', flag ->> 'reason',
      'riskLevel', private.storyops_estimate_blocker_risk(flag ->> 'reason'),
      'summary', btrim(flag ->> 'summary'),
      'blocking', true
    )
    order by
      flag ->> 'reason',
      btrim(flag ->> 'summary'),
      flag::text
  )
  into canonical_blocking_flags
  from jsonb_array_elements(blocking_flags) flag;
  if canonical_blocking_flags <> blocking_flags then
    raise exception 'ESTIMATE_APPROVAL_BLOCKERS_NOT_CANONICAL';
  end if;

  canonical_exact_payload := jsonb_build_object(
    'schemaVersion', 'storyops-estimate-exception-exact-v1',
    'operation', 'estimate.approve_exception',
    'companyId', new.company_id,
    'estimateId', exact_payload ->> 'estimateId',
    'quoteId', exact_payload ->> 'quoteId',
    'intentHash', exact_payload ->> 'intentHash',
    'authoritativeSnapshotHash',
      exact_payload ->> 'authoritativeSnapshotHash',
    'snapshot', exact_payload -> 'snapshot',
    'blockingFlags', canonical_blocking_flags
  );
  if canonical_exact_payload <> exact_payload then
    raise exception 'ESTIMATE_APPROVAL_EXACT_PAYLOAD_NOT_CANONICAL';
  end if;

  expected_risk := private.storyops_estimate_envelope_risk(new.action_payload);
  expected_reason := private.storyops_estimate_envelope_reason(new.action_payload);
  if new.risk_level <> expected_risk or new.reason <> expected_reason then
    raise exception 'ESTIMATE_APPROVAL_RISK_BINDING_MISMATCH';
  end if;

  estimate_id_value := nullif(exact_payload ->> 'estimateId', '')::uuid;
  quote_id_value := nullif(exact_payload ->> 'quoteId', '')::uuid;
  if estimate_id_value is null
    or quote_id_value is null
    or new.entity_type <> 'estimate'
    or new.entity_id is distinct from estimate_id_value
  then
    raise exception 'ESTIMATE_APPROVAL_SCOPE_MISMATCH';
  end if;

  if new.status = 'approved' then
    select jsonb_build_object(
      'priceBookId', estimate.price_book_id,
      'priceBookVersion', estimate.price_book_version,
      'serviceTermsId', terms.id,
      'termsVersion', quote.terms_version,
      'calculationVersion', estimate.calculation_version,
      'total', estimate.total::text,
      'depositRequired', estimate.deposit_required::text,
      'discount', estimate.discount::text,
      'marginPercent', estimate.estimated_margin_pct::text
    )
    into expected_snapshot
    from public.estimates estimate
    join public.quotes quote
      on quote.id = quote_id_value
      and quote.estimate_id = estimate.id
      and quote.company_id = estimate.company_id
    join public.service_terms terms
      on terms.id =
        nullif(exact_payload #>> '{snapshot,serviceTermsId}', '')::uuid
      and terms.company_id = quote.company_id
      and terms.version_label = quote.terms_version
      and terms.terms_text = quote.terms_snapshot
    where estimate.id = estimate_id_value
      and estimate.company_id = new.company_id
      and estimate.status = 'pending_approval'
      and quote.status = 'pending_approval'
    for update of estimate, quote;
    if expected_snapshot is null
      or expected_snapshot <> exact_payload -> 'snapshot'
    then
      raise exception 'ESTIMATE_APPROVAL_EXACT_PAYLOAD_MISMATCH';
    end if;

    update public.estimates
    set status = 'approved'
    where id = estimate_id_value
      and company_id = new.company_id
      and status = 'pending_approval';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then
      raise exception 'ESTIMATE_APPROVAL_ESTIMATE_STATE_CONFLICT';
    end if;

    update public.quotes
    set status = 'draft'
    where id = quote_id_value
      and company_id = new.company_id
      and status = 'pending_approval';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then
      raise exception 'ESTIMATE_APPROVAL_QUOTE_STATE_CONFLICT';
    end if;

    perform private.authorize_storyops_approval_consumption(
      new.company_id,
      new.id
    );
    update public.approval_requests
    set
      consumed_at = now(),
      execution_receipt = jsonb_build_object(
        'schemaVersion', 'storyops-estimate-exception-consumption-v1',
        'kind', 'estimate-exception-decision',
        'estimateId', estimate_id_value,
        'quoteId', quote_id_value,
        'decidedBy', new.decided_by,
        'decidedAt', new.decided_at,
        'payloadHash', stored_payload_hash,
        'intentHash', exact_payload ->> 'intentHash',
        'authoritativeSnapshotHash',
          exact_payload ->> 'authoritativeSnapshotHash',
        'snapshot', exact_payload -> 'snapshot',
        'blockingFlags', blocking_flags,
        'riskLevel', expected_risk
      )
    where id = new.id
      and company_id = new.company_id
      and status = 'approved'
      and action_payload ->> 'payloadHash' = stored_payload_hash
      and action_payload -> 'exactPayload' = exact_payload
      and consumed_at is null;
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then
      raise exception 'ESTIMATE_APPROVAL_CONSUMPTION_CONFLICT';
    end if;
  else
    update public.estimates
    set status = 'needs_input'
    where id = estimate_id_value
      and company_id = new.company_id
      and status = 'pending_approval';
    update public.quotes
    set status = 'void'
    where id = quote_id_value
      and company_id = new.company_id
      and status = 'pending_approval';
  end if;
  return new;
end;
$$;

revoke all on function public.apply_estimate_exception_decision()
  from public, anon, authenticated, service_role;

comment on function public.canonicalize_estimate_approval_request() is
  'Builds the deterministic estimate-approval envelope, complete sorted blocker list, exact snapshot hash, and highest-risk row projection before insertion.';
comment on function public.apply_estimate_exception_decision() is
  'Consumes an owner estimate-exception decision only after recomputing the complete exact-payload hash, blocker risks, and authoritative estimate/quote snapshot.';
