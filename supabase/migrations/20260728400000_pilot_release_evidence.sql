-- Reviewed pilot-release evidence is appended to the existing audit ledger.
-- This boundary records references and hashes only. It does not execute a
-- canary, activate a provider, change company status, or authorize launch.

create or replace function public.record_storyops_pilot_release_evidence(
  p_company_id uuid,
  p_command_id uuid,
  p_request_hash text,
  p_kind text,
  p_provider text,
  p_outcome text,
  p_source text,
  p_evidence_reference text,
  p_artifact_sha256 text,
  p_observed_at timestamptz,
  p_expires_at timestamptz,
  p_review_note text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  reservation public.idempotency_keys%rowtype;
  reservation_id uuid;
  evidence_id uuid := gen_random_uuid();
  effective_request_hash text;
  request_fingerprint text;
  record_value jsonb;
  response_value jsonb;
  maximum_validity interval;
  published_configuration jsonb;
begin
  if actor_user_id is null then
    raise exception 'PILOT_EVIDENCE_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    join public.companies company
      on company.id = membership.company_id
     and company.status = 'active'
    where membership.company_id = p_company_id
      and membership.user_id = actor_user_id
      and membership.role = 'owner'
      and membership.active
  ) then
    raise exception 'PILOT_EVIDENCE_ACTIVE_OWNER_REQUIRED';
  end if;

  if p_company_id is null
    or p_command_id is null
    or p_request_hash is null
    or p_request_hash !~ '^[a-f0-9]{64}$'
    or p_kind not in ('provider_canary', 'field_media_canary', 'backup_restore')
    or p_outcome not in ('passed', 'failed')
    or p_source not in (
      'external_provider_receipt',
      'storage_roundtrip',
      'isolated_restore_drill'
    )
    or p_evidence_reference is null
    or length(btrim(p_evidence_reference)) not between 5 and 120
    or btrim(p_evidence_reference) !~ '^[A-Za-z0-9][A-Za-z0-9._-]{4,119}$'
    or btrim(p_evidence_reference)
      ~* '(^|[._-])(secret|password|token|bearer|api[._-]?key|access[._-]?key|private[._-]?key)([._-]|$)|^(sk|pk)_(live|test)_|^sk-proj-|^whsec_|^eyJ'
    or p_artifact_sha256 is null
    or p_artifact_sha256 !~ '^[a-f0-9]{64}$'
    or p_observed_at is null
    or p_expires_at is null
    or p_review_note is null
    or length(btrim(p_review_note)) not between 10 and 120
    or btrim(p_review_note) !~ '^[A-Za-z0-9][A-Za-z0-9._-]{9,119}$'
    or btrim(p_review_note)
      ~* '(^|[._-])(secret|password|token|bearer|api[._-]?key|access[._-]?key|private[._-]?key)([._-]|$)|^(sk|pk)_(live|test)_|^sk-proj-|^whsec_|^eyJ'
  then
    raise exception 'PILOT_EVIDENCE_INVALID_REQUEST';
  end if;

  if (
    p_kind = 'provider_canary'
    and (
      p_provider is null
      or p_provider not in (
        'openai',
        'twilio',
        'email',
        'stripe',
        'google_calendar',
        'maps',
        'nws',
        'vroom',
        'storage',
        'signed_storage_targets',
        'quickbooks_export'
      )
      or p_source <> 'external_provider_receipt'
    )
  )
    or (
      p_kind <> 'provider_canary'
      and p_provider is not null
    )
    or (
      p_kind = 'field_media_canary'
      and p_source <> 'storage_roundtrip'
    )
    or (
      p_kind = 'backup_restore'
      and p_source <> 'isolated_restore_drill'
    )
  then
    raise exception 'PILOT_EVIDENCE_KIND_SOURCE_MISMATCH';
  end if;

  maximum_validity := case
    when p_kind = 'provider_canary' then interval '7 days'
    else interval '30 days'
  end;
  if p_observed_at < now() - interval '90 days'
    or p_observed_at > now()
    or p_expires_at <= now()
    or p_expires_at <= p_observed_at
    or p_expires_at > p_observed_at + maximum_validity
  then
    raise exception 'PILOT_EVIDENCE_TIME_INVALID';
  end if;

  if p_kind = 'provider_canary' then
    if not exists (
      select 1
      from public.integration_connections connection
      where connection.company_id = p_company_id
        and connection.provider = p_provider
    ) then
      raise exception 'PILOT_EVIDENCE_PROVIDER_NOT_CONFIGURED';
    end if;
  elsif p_kind = 'field_media_canary' and not exists (
    select 1
    from public.integration_connections connection
    where connection.company_id = p_company_id
      and connection.provider in ('storage', 'signed_storage_targets')
  ) then
    raise exception 'PILOT_EVIDENCE_STORAGE_NOT_CONFIGURED';
  end if;

  if p_outcome = 'passed' and p_kind in ('provider_canary', 'field_media_canary') then
    select configuration.configuration
    into published_configuration
    from public.company_configuration_versions configuration
    where configuration.company_id = p_company_id
      and configuration.status = 'published';
    if published_configuration is null then
      raise exception 'PILOT_EVIDENCE_PUBLISHED_CONFIGURATION_REQUIRED';
    end if;
  end if;

  if p_outcome = 'passed' and p_kind = 'provider_canary' then
    if not exists (
      select 1
      from public.integration_connections connection
      where connection.company_id = p_company_id
        and connection.provider = p_provider
        and connection.mode = 'live'
        and connection.status = 'healthy'
        and connection.last_checked_at between
          p_observed_at - interval '15 minutes'
          and p_observed_at + interval '5 minutes'
    )
      or not exists (
      select 1
      from jsonb_array_elements(
          coalesce(published_configuration #> '{integrations,providers}', '[]'::jsonb)
        ) configured(provider)
        where configured.provider ->> 'provider' = case
            when p_provider = 'signed_storage_targets' then 'storage'
            else p_provider
          end
          and configured.provider ->> 'requestedMode' = 'live'
          and coalesce((configured.provider ->> 'environmentEnabled')::boolean, false)
          and coalesce((configured.provider ->> 'ownerEnabled')::boolean, false)
          and configured.provider ->> 'health' = 'healthy'
      )
    then
      raise exception 'PILOT_EVIDENCE_LIVE_PROVIDER_REQUIRED';
    end if;
  end if;

  if p_outcome = 'passed' and p_kind = 'field_media_canary' then
    if not exists (
      select 1
      from public.integration_connections connection
      where connection.company_id = p_company_id
        and connection.provider in ('storage', 'signed_storage_targets')
        and connection.mode = 'live'
        and connection.status = 'healthy'
        and connection.last_checked_at between
          p_observed_at - interval '15 minutes'
          and p_observed_at + interval '5 minutes'
    )
      or not exists (
        select 1
        from jsonb_array_elements(
          coalesce(published_configuration #> '{integrations,providers}', '[]'::jsonb)
        ) configured(provider)
        where configured.provider ->> 'provider' = 'storage'
          and configured.provider ->> 'requestedMode' = 'live'
          and coalesce((configured.provider ->> 'environmentEnabled')::boolean, false)
          and coalesce((configured.provider ->> 'ownerEnabled')::boolean, false)
          and configured.provider ->> 'health' = 'healthy'
      )
    then
      raise exception 'PILOT_EVIDENCE_LIVE_STORAGE_REQUIRED';
    end if;
  end if;

  request_fingerprint := array_to_string(
    array[
      'storyops-pilot-release-evidence-v1',
      p_kind,
      coalesce(p_provider, ''),
      p_outcome,
      p_source,
      btrim(p_evidence_reference),
      p_artifact_sha256,
      to_char(
        p_observed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      to_char(
        p_expires_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      btrim(p_review_note)
    ],
    chr(31)
  );
  effective_request_hash := encode(
    extensions.digest(request_fingerprint, 'sha256'),
    'hex'
  );
  if p_request_hash <> effective_request_hash then
    raise exception 'PILOT_EVIDENCE_REQUEST_HASH_MISMATCH';
  end if;

  insert into public.idempotency_keys(
    company_id,
    scope,
    key,
    request_hash,
    expires_at
  )
  values (
    p_company_id,
    'pilot-release-evidence-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into reservation_id;

  if reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys key_record
    where key_record.company_id = p_company_id
      and key_record.scope = 'pilot-release-evidence-v1'
      and key_record.key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'PILOT_EVIDENCE_IDEMPOTENCY_CONFLICT';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'PILOT_EVIDENCE_COMMAND_IN_PROGRESS';
  end if;

  record_value := jsonb_strip_nulls(jsonb_build_object(
    'id', evidence_id,
    'companyId', p_company_id,
    'kind', p_kind,
    'provider', p_provider,
    'outcome', p_outcome,
    'source', p_source,
    'evidenceReference', btrim(p_evidence_reference),
    'artifactSha256', p_artifact_sha256,
    'observedAt', p_observed_at,
    'expiresAt', p_expires_at,
    'reviewedByUserId', actor_user_id,
    'verificationBasis', 'owner_attestation',
    'reviewNote', btrim(p_review_note),
    'recordedAt', now()
  ));

  insert into public.audit_events(
    company_id,
    occurred_at,
    actor_type,
    actor_id,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    request_id,
    retention_class,
    retain_until
  )
  values (
    p_company_id,
    (record_value ->> 'recordedAt')::timestamptz,
    'user',
    actor_user_id::text,
    'pilot.evidence_recorded',
    'pilot_release_evidence',
    evidence_id,
    null,
    record_value - array['companyId', 'id', 'recordedAt']::text[],
    p_command_id::text,
    'audit',
    now() + interval '7 years'
  );

  response_value := jsonb_build_object(
    'schemaVersion', 'storyops-pilot-evidence-receipt-v1',
    'companyId', p_company_id,
    'commandId', p_command_id,
    'requestHash', effective_request_hash,
    'record', record_value,
    'replayed', false,
    'serverTime', now()
  );

  update public.idempotency_keys
  set
    status = 'completed',
    response = response_value,
    completed_at = now()
  where id = reservation_id
    and status = 'in_progress';
  if not found then
    raise exception 'PILOT_EVIDENCE_COMMAND_RESERVATION_LOST';
  end if;

  return response_value;
end;
$$;

create or replace function public.get_storyops_pilot_release_evidence(
  p_company_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
begin
  if actor_user_id is null then
    raise exception 'PILOT_EVIDENCE_AUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.company_memberships membership
    join public.companies company
      on company.id = membership.company_id
     and company.status = 'active'
    where membership.company_id = p_company_id
      and membership.user_id = actor_user_id
      and membership.role in ('owner', 'dispatcher')
      and membership.active
  ) then
    raise exception 'PILOT_EVIDENCE_ACTIVE_STAFF_REQUIRED';
  end if;

  return jsonb_build_object(
    'schemaVersion', 'storyops-pilot-evidence-state-v1',
    'companyId', p_company_id,
    'records', coalesce((
      select jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'id', event.entity_id,
          'companyId', event.company_id,
          'kind', event.after_data ->> 'kind',
          'provider', event.after_data ->> 'provider',
          'outcome', event.after_data ->> 'outcome',
          'source', event.after_data ->> 'source',
          'evidenceReference', event.after_data ->> 'evidenceReference',
          'artifactSha256', event.after_data ->> 'artifactSha256',
          'observedAt', event.after_data ->> 'observedAt',
          'expiresAt', event.after_data ->> 'expiresAt',
          'reviewedByUserId', event.after_data ->> 'reviewedByUserId',
          'verificationBasis', event.after_data ->> 'verificationBasis',
          'binding', event.after_data -> 'binding',
          'reviewNote', event.after_data ->> 'reviewNote',
          'recordedAt', event.occurred_at
        ))
        order by
          event.occurred_at desc,
          case when event.after_data ->> 'outcome' = 'failed' then 0 else 1 end,
          (event.after_data ->> 'observedAt')::timestamptz desc,
          event.entity_id desc
      )
      from (
        select audit.*
        from public.audit_events audit
        where audit.company_id = p_company_id
          and audit.action = 'pilot.evidence_recorded'
          and audit.entity_type = 'pilot_release_evidence'
          and audit.entity_id is not null
        order by audit.occurred_at desc, audit.id desc
        limit 200
      ) event
    ), '[]'::jsonb),
    'serverTime', now()
  );
end;
$$;

revoke all on function public.record_storyops_pilot_release_evidence(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  text
) from public, anon, authenticated, service_role;
grant execute on function public.record_storyops_pilot_release_evidence(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  text
) to authenticated;

revoke all on function public.get_storyops_pilot_release_evidence(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_storyops_pilot_release_evidence(uuid)
  to authenticated;

comment on function public.record_storyops_pilot_release_evidence(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  timestamptz,
  timestamptz,
  text
) is
  'Append-only owner attestation boundary for external canary, Storage roundtrip, and isolated restore references. Passed provider/media attestations require current live configuration plus healthy dual-enabled integration state, but owner attestations are never trusted system proof and cannot satisfy launch readiness. The record does not run a check, activate a provider, or authorize launch.';

comment on function public.get_storyops_pilot_release_evidence(uuid) is
  'Active owner/dispatcher projection of up to 200 append-only release-evidence audit records without provider secrets or raw artifacts.';
