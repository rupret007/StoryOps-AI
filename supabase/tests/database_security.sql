\set ON_ERROR_STOP on

-- Transactional database contract suite.
-- Run after `supabase start` or `supabase db reset`:
-- docker exec -i supabase_db_storyops-ai psql -U postgres -d postgres \
--   < supabase/tests/database_security.sql

begin;

\echo '1/9 tenant references fail closed'
insert into public.companies(id, name, timezone)
values (
  '20000000-0000-4000-8000-000000000001',
  'Isolation Test Company',
  'America/Chicago'
);
do $$
declare
  blocked boolean := false;
begin
  begin
    insert into public.properties(
      id, company_id, customer_id, name, service_address
    )
    values (
      '20000000-0000-4000-8000-000000000211',
      '20000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000201',
      'Cross-tenant property',
      '{"line1":"1 Isolation Way"}'::jsonb
    );
  exception
    when others then
      if position('Cross-company reference rejected' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Cross-tenant property/customer reference was accepted';
  end if;
end;
$$;

\echo '2/9 owner workspace and idempotent command boundary'
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
select set_config('request.headers', '{}', true);
do $$
declare
  workspace jsonb;
  first_result jsonb;
  replay_result jsonb;
  qualified_result jsonb;
  rejected boolean := false;
begin
  workspace := public.get_storyops_workspace(
    '10000000-0000-4000-8000-000000000001'
  );
  if workspace #>> '{session,role}' <> 'owner'
    or not workspace ?& array[
      'leads', 'estimates', 'jobs', 'timeEntries', 'materialUsage', 'media',
      'completionSignatures', 'approvals', 'integrationHealth'
    ]
    or jsonb_typeof(workspace -> 'timeEntries') <> 'array'
  then
    raise exception 'Owner workspace projection is incomplete or mislabeled';
  end if;

  first_result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    'lead.create',
    0,
    '{
      "entityId":"91000000-0000-4000-8000-000000000101",
      "source":"web",
      "displayName":"Command Contract Lead",
      "email":"contract@example.test",
      "requestedServices":["gutter-cleaning"],
      "preferredContactChannel":"email"
    }'::jsonb,
    repeat('0', 64)
  );
  replay_result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000001',
    'lead.create',
    0,
    '{
      "entityId":"91000000-0000-4000-8000-000000000101",
      "source":"web",
      "displayName":"Command Contract Lead",
      "email":"contract@example.test",
      "requestedServices":["gutter-cleaning"],
      "preferredContactChannel":"email"
    }'::jsonb,
    repeat('0', 64)
  );
  if coalesce((first_result ->> 'replayed')::boolean, true)
    or not coalesce((replay_result ->> 'replayed')::boolean, false)
    or first_result ->> 'requestHash' = repeat('0', 64)
  then
    raise exception 'Command idempotency/recomputed hash contract failed';
  end if;

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000002',
      'lead.qualify',
      99,
      '{
        "entityId":"91000000-0000-4000-8000-000000000101",
        "status":"qualified",
        "qualificationSummary":"Test"
      }'::jsonb,
      repeat('0', 64)
    );
  exception
    when others then
      if position('version or transition conflict' in sqlerrm) > 0 then
        rejected := true;
      else
        raise;
      end if;
  end;
  if not rejected then
    raise exception 'Stale lead command was accepted';
  end if;

  qualified_result := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000003',
    'lead.qualify',
    1,
    '{
      "entityId":"91000000-0000-4000-8000-000000000101",
      "status":"qualified",
      "qualificationSummary":"Address and service confirmed"
    }'::jsonb,
    repeat('0', 64)
  );
  if (qualified_result ->> 'version')::integer <> 2 then
    raise exception 'Successful versioned lead command did not advance version';
  end if;
end;
$$;

\echo '3/9 malformed audit metadata blocks the mutation and PII is redacted'
do $$
declare
  blocked boolean := false;
begin
  perform set_config('request.headers', 'not-json', true);
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000010',
      'lead.qualify',
      1,
      '{
        "entityId":"10000000-0000-4000-8000-000000000221",
        "status":"qualified",
        "qualificationSummary":"must roll back"
      }'::jsonb,
      repeat('0', 64)
    );
  exception
    when invalid_text_representation then
      blocked := true;
  end;
  if not blocked then
    raise exception 'Malformed request audit metadata did not fail closed';
  end if;
  perform set_config('request.headers', '{}', true);
end;
$$;
reset role;
do $$
declare
  recorded jsonb;
begin
  if not exists (
    select 1 from public.leads
    where id = '10000000-0000-4000-8000-000000000221'
      and version = 1
      and qualification_summary is null
  ) then
    raise exception 'Audit failure did not roll back the business mutation';
  end if;
  select audit.after_data
  into recorded
  from public.audit_events audit
  where audit.entity_type = 'customers'
    and audit.entity_id = '10000000-0000-4000-8000-000000000201'
    and audit.action = 'insert'
  order by audit.occurred_at
  limit 1;
  if recorded ? 'email'
    or recorded ? 'phone'
    or not (recorded -> '_redacted_fields') ? 'email'
    or coalesce(recorded ->> '_source_sha256', '') !~ '^[a-f0-9]{64}$'
  then
    raise exception 'Customer audit event retained unredacted PII';
  end if;
end;
$$;

\echo '4/9 destructive actions require and consume exact owner approval'
do $$
declare
  blocked boolean := false;
  decision jsonb;
begin
  begin
    delete from public.leads
    where id = '10000000-0000-4000-8000-000000000221';
  exception
    when others then
      if position('Exact owner approval is required' in sqlerrm) > 0 then
        blocked := true;
      else
        raise;
      end if;
  end;
  if not blocked then
    raise exception 'Unapproved destructive delete was accepted';
  end if;

  insert into public.approval_requests(
    id, company_id, reason, risk_level, requested_by_type, requested_by_id,
    entity_type, entity_id, action_type, action_payload, summary, policy_version
  )
  values (
    '91000000-0000-4000-8000-000000000801',
    '10000000-0000-4000-8000-000000000001',
    'destructive_change',
    'high',
    'user',
    '10000000-0000-4000-8000-000000000101',
    'leads',
    '10000000-0000-4000-8000-000000000221',
    'delete',
    jsonb_build_object(
      'exactPayload',
      jsonb_build_object(
        'action', 'delete',
        'entityType', 'leads',
        'entityId', '10000000-0000-4000-8000-000000000221'::uuid
      )
    ),
    'Delete the exact test lead',
    'approval-policy-v1'
  );
  decision := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000802',
    'approval.decide',
    1,
    '{
      "entityId":"91000000-0000-4000-8000-000000000801",
      "decision":"approved",
      "decisionNote":"Exact record reviewed"
    }'::jsonb,
    repeat('0', 64)
  );
  delete from public.leads
  where id = '10000000-0000-4000-8000-000000000221';
  if exists (
      select 1 from public.leads
      where id = '10000000-0000-4000-8000-000000000221'
    )
    or not exists (
      select 1 from public.approval_requests
      where id = '91000000-0000-4000-8000-000000000801'
        and consumed_at is not null
        and execution_receipt ->> 'action' = 'delete'
    )
  then
    raise exception 'Exact delete approval was not consumed atomically';
  end if;
end;
$$;
reset role;

\echo '5/9 technician projection is assignment-scoped and hides financials'
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000103',
  true
);
select set_config('request.headers', '{}', true);
do $$
declare
  workspace jsonb;
  started jsonb;
  stopped jsonb;
  visit_version integer;
begin
  workspace := public.get_storyops_workspace(
    '10000000-0000-4000-8000-000000000001'
  );
  if workspace #>> '{session,role}' <> 'technician'
    or jsonb_array_length(workspace -> 'jobs') = 0
    or exists (
      select 1 from jsonb_array_elements(workspace -> 'jobs') job
      where job ? 'estimatedRevenue' or job ? 'estimatedCost'
    )
    or has_table_privilege(current_user, 'public.jobs', 'SELECT')
  then
    raise exception 'Technician projection or base privileges leaked financial rows';
  end if;

  select (visit ->> 'version')::integer
  into visit_version
  from jsonb_array_elements(workspace -> 'visits') visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';

  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000604',
    'visit.transition',
    visit_version,
    '{
      "entityId":"10000000-0000-4000-8000-000000000641",
      "status":"en_route"
    }'::jsonb,
    repeat('0', 64)
  );

  select (visit ->> 'version')::integer
  into visit_version
  from jsonb_array_elements(
    public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    ) -> 'visits'
  ) visit
  where visit ->> 'id' = '10000000-0000-4000-8000-000000000641';

  perform public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000605',
    'visit.transition',
    visit_version,
    '{
      "entityId":"10000000-0000-4000-8000-000000000641",
      "status":"on_site"
    }'::jsonb,
    repeat('0', 64)
  );

  started := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000601',
    'time.start',
    0,
    '{
      "entityId":"91000000-0000-4000-8000-000000000602",
      "visitId":"10000000-0000-4000-8000-000000000641",
      "userId":"10000000-0000-4000-8000-000000000101"
    }'::jsonb,
    repeat('0', 64)
  );
  stopped := public.execute_storyops_command(
    '10000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000603',
    'time.stop',
    1,
    '{
      "entityId":"91000000-0000-4000-8000-000000000602"
    }'::jsonb,
    repeat('0', 64)
  );
  if (stopped ->> 'version')::integer <> 2 then
    raise exception 'Technician time recovery did not advance version';
  end if;
end;
$$;
reset role;
do $$
begin
  if not exists (
    select 1 from public.time_entries
    where id = '91000000-0000-4000-8000-000000000602'
      and user_id = '10000000-0000-4000-8000-000000000103'
      and ended_at is not null
  ) then
    raise exception 'Technician command accepted an impersonated time user';
  end if;
end;
$$;

\echo '6/9 customer portal receives only its sanitized projection'
insert into storage.objects(bucket_id, name, metadata)
values (
  'job-media',
  '10000000-0000-4000-8000-000000000001/customers/10000000-0000-4000-8000-000000000201/scope.jpg',
  '{"size":1024,"mimetype":"image/jpeg"}'::jsonb
);
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000104',
  true
);
select set_config('request.headers', '{}', true);
do $$
declare
  workspace jsonb;
  denied boolean := false;
  media_denied boolean := false;
begin
  workspace := public.get_storyops_workspace(
    '10000000-0000-4000-8000-000000000001'
  );
  if workspace #>> '{session,role}' <> 'customer'
    or workspace ? 'leads'
    or jsonb_array_length(workspace -> 'customers') <> 1
    or exists (
      select 1 from jsonb_array_elements(workspace -> 'jobs') job
      where job ? 'estimatedRevenue' or job ? 'estimatedCost'
    )
    or exists (
      select 1 from jsonb_array_elements(workspace -> 'payments') payment
      where payment ? 'provider' or payment ? 'providerPaymentId'
    )
    or has_table_privilege(current_user, 'public.estimates', 'SELECT')
    or has_table_privilege(current_user, 'public.jobs', 'SELECT')
    or has_table_privilege(current_user, 'public.invoices', 'SELECT')
    or has_table_privilege(current_user, 'public.payments', 'SELECT')
    or has_table_privilege(current_user, 'public.customers', 'SELECT')
    or has_table_privilege(current_user, 'public.properties', 'SELECT')
    or has_table_privilege(current_user, 'public.media_assets', 'INSERT')
    or has_table_privilege(current_user, 'public.media_assets', 'UPDATE')
    or has_table_privilege(current_user, 'public.completion_signatures', 'INSERT')
    or has_table_privilege(current_user, 'public.completion_signatures', 'UPDATE')
    or public.can_upload_job_media_object(
      '10000000-0000-4000-8000-000000000001/customers/10000000-0000-4000-8000-000000000201/portal-orphan.png'
    )
  then
    raise exception 'Customer projection or base privileges exposed internal data';
  end if;

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000701',
      'approval.decide',
      1,
      '{
        "entityId":"10000000-0000-4000-8000-000000000801",
        "decision":"approved"
      }'::jsonb,
      repeat('0', 64)
    );
  exception
    when others then
      if position('Only an owner' in sqlerrm) > 0 then
        denied := true;
      else
        raise;
      end if;
  end;
  if not denied then
    raise exception 'Customer could decide an owner approval';
  end if;

  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000702',
      'media.register',
      0,
      '{
        "entityId":"91000000-0000-4000-8000-000000000703",
        "customerId":"10000000-0000-4000-8000-000000000201",
        "propertyId":"10000000-0000-4000-8000-000000000211",
        "purpose":"scope",
        "objectPath":"10000000-0000-4000-8000-000000000001/customers/10000000-0000-4000-8000-000000000201/scope.jpg",
        "contentType":"image/jpeg",
        "byteSize":1024,
        "checksumSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }'::jsonb,
      repeat('0', 64)
    );
  exception
    when others then
      if position('Object path is outside the actor upload scope' in sqlerrm) > 0
        or position('trusted field-media finalizer' in sqlerrm) > 0
      then
        media_denied := true;
      else
        raise;
      end if;
  end;
  if not media_denied then
    raise exception 'Customer media command bypassed the trusted finalizer';
  end if;
end;
$$;
reset role;
do $$
begin
  if exists (
    select 1 from public.media_assets media
    where media.id = '91000000-0000-4000-8000-000000000703'
  ) then
    raise exception 'Rejected customer media command still created metadata';
  end if;
end;
$$;

\echo '7/9 non-members cannot use either live RPC'
set local role authenticated;
select set_config(
  'request.jwt.claim.sub',
  '90000000-0000-4000-8000-000000000999',
  true
);
do $$
declare
  denied_read boolean := false;
  denied_write boolean := false;
begin
  begin
    perform public.get_storyops_workspace(
      '10000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if position('No active company membership' in sqlerrm) > 0 then
        denied_read := true;
      else
        raise;
      end if;
  end;
  begin
    perform public.execute_storyops_command(
      '10000000-0000-4000-8000-000000000001',
      '91000000-0000-4000-8000-000000000901',
      'lead.create',
      0,
      '{"entityId":"91000000-0000-4000-8000-000000000902"}'::jsonb,
      repeat('0', 64)
    );
  exception
    when others then
      if position('No active company membership' in sqlerrm) > 0 then
        denied_write := true;
      else
        raise;
      end if;
  end;
  if not denied_read or not denied_write then
    raise exception 'A non-member reached a live data boundary';
  end if;
end;
$$;
reset role;

\echo '8/9 service webhook and idempotency leases are duplicate-safe'
set local role service_role;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  first_claim record;
  duplicate_claim record;
  key_claim record;
  key_retry record;
  key_complete record;
  key_conflict record;
  cross_tenant_blocked boolean := false;
begin
  select * into first_claim
  from public.claim_webhook_event(
    'stripe',
    'evt_database_contract',
    'checkout.session.completed',
    repeat('a', 64),
    '{"id":"evt_database_contract"}'::jsonb,
    '10000000-0000-4000-8000-000000000001'
  );
  select * into duplicate_claim
  from public.claim_webhook_event(
    'stripe',
    'evt_database_contract',
    'checkout.session.completed',
    repeat('a', 64),
    '{"id":"evt_database_contract"}'::jsonb,
    '10000000-0000-4000-8000-000000000001'
  );
  if not first_claim.claimed or duplicate_claim.claimed
    or first_claim.event_id <> duplicate_claim.event_id
    or not public.start_webhook_processing(
      first_claim.event_id,
      repeat('a', 64)
    )
  then
    raise exception 'Webhook claim/lease contract failed';
  end if;
  perform public.complete_webhook_event(
    first_claim.event_id,
    repeat('a', 64),
    'processed'
  );
  if public.start_webhook_processing(first_claim.event_id, repeat('a', 64)) then
    raise exception 'Processed webhook acquired a second lease';
  end if;

  begin
    perform public.claim_webhook_event(
      'stripe',
      'evt_database_contract',
      'checkout.session.completed',
      repeat('a', 64),
      '{"id":"evt_database_contract"}'::jsonb,
      '20000000-0000-4000-8000-000000000001'
    );
  exception
    when others then
      if position('across companies' in sqlerrm) > 0 then
        cross_tenant_blocked := true;
      else
        raise;
      end if;
  end;
  if not cross_tenant_blocked then
    raise exception 'Provider event ID was reusable across tenants';
  end if;

  select * into key_claim from public.claim_idempotency_key(
    '10000000-0000-4000-8000-000000000001',
    'database-contract',
    'retryable-key',
    repeat('b', 64),
    now() + interval '1 hour'
  );
  perform public.fail_idempotency_key(
    '10000000-0000-4000-8000-000000000001',
    'database-contract',
    'retryable-key',
    repeat('b', 64),
    'TRANSIENT_TEST'
  );
  select * into key_retry from public.claim_idempotency_key(
    '10000000-0000-4000-8000-000000000001',
    'database-contract',
    'retryable-key',
    repeat('b', 64),
    now() + interval '1 hour'
  );
  perform public.complete_idempotency_key(
    '10000000-0000-4000-8000-000000000001',
    'database-contract',
    'retryable-key',
    repeat('b', 64),
    '{"ok":true}'::jsonb
  );
  select * into key_complete from public.claim_idempotency_key(
    '10000000-0000-4000-8000-000000000001',
    'database-contract',
    'retryable-key',
    repeat('b', 64),
    now() + interval '1 hour'
  );
  select * into key_conflict from public.claim_idempotency_key(
    '10000000-0000-4000-8000-000000000001',
    'database-contract',
    'retryable-key',
    repeat('c', 64),
    now() + interval '1 hour'
  );
  if key_claim.claim_status <> 'reserved'
    or key_retry.claim_status <> 'reserved'
    or key_complete.claim_status <> 'completed'
    or key_complete.stored_response <> '{"ok":true}'::jsonb
    or key_conflict.claim_status <> 'conflict'
  then
    raise exception 'Idempotency fail/retry/complete/conflict contract failed';
  end if;
end;
$$;

\echo '9/9 retention is reportable in draft and cannot purge before legal activation'
do $$
declare
  dry_run_result record;
  purge_blocked boolean := false;
begin
  select * into dry_run_result
  from public.apply_retention_policy(
    '10000000-0000-4000-8000-000000000001',
    now(),
    true,
    null
  );
  if dry_run_result.evidence_sha256 !~ '^[a-f0-9]{64}$'
    or dry_run_result.affected_counts <> '{}'::jsonb
  then
    raise exception 'Retention dry-run evidence is invalid';
  end if;
  begin
    perform public.apply_retention_policy(
      '10000000-0000-4000-8000-000000000001',
      now(),
      false,
      null
    );
  exception
    when others then
      if position('legally reviewed active policy' in sqlerrm) > 0 then
        purge_blocked := true;
      else
        raise;
      end if;
  end;
  if not purge_blocked then
    raise exception 'Draft retention policy could execute a purge';
  end if;
end;
$$;
reset role;

rollback;
\echo 'StoryOps database security contract passed'
