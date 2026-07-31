\set ON_ERROR_STOP on

begin;

\echo '1/3 invitation attempt authority is durable, email-scoped, and service-only'
do $$
declare
  authority_definition text;
  authorization_definition text;
begin
  select pg_get_functiondef(
    'private.claim_storyops_identity_invitation_attempt(uuid,uuid,uuid,text)'::regprocedure
  )
  into authority_definition;
  select pg_get_functiondef(
    'public.authorize_storyops_identity_invite(uuid,uuid,uuid,text,text)'::regprocedure
  )
  into authorization_definition;

  if to_regclass('public.identity_invitation_attempts') is null
    or has_table_privilege(
      'authenticated',
      'public.identity_invitation_attempts',
      'SELECT'
    )
    or has_table_privilege(
      'service_role',
      'public.identity_invitation_attempts',
      'SELECT'
    )
    or has_function_privilege(
      'authenticated',
      'public.record_storyops_identity_invite_blocked(uuid,uuid,uuid,text)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.record_storyops_identity_invite_blocked(uuid,uuid,uuid,text)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.load_storyops_identity_invitation_attempt_state(uuid,uuid)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.load_storyops_identity_invitation_attempt_state(uuid,uuid)',
      'EXECUTE'
    )
    or position('storyops-identity:' in authority_definition) = 0
    or position(
      'storyops-identity-command:' in authority_definition
    ) >= position('storyops-identity:' in authority_definition)
    or position('storyops-identity:' in authority_definition)
      >= position('for update' in lower(authority_definition))
    or position(
      'claim_storyops_identity_invitation_attempt'
      in authorization_definition
    ) = 0
    or position(
      'identity_invitation_attempts_one_unresolved_email_idx'
      in pg_get_indexdef(
        'public.identity_invitation_attempts_one_unresolved_email_idx'::regclass
      )
    ) = 0
  then
    raise exception
      'The email-scoped invitation attempt authority is incomplete';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

\echo '2/3 different commands share one provider claim until deterministic expiry'
do $$
declare
  company_id_value uuid :=
    '10000000-0000-4000-8000-000000000001';
  owner_id_value uuid :=
    '10000000-0000-4000-8000-000000000101';
  command_a uuid :=
    '63000000-0000-4000-8000-000000000001';
  command_b uuid :=
    '63000000-0000-4000-8000-000000000002';
  command_c uuid :=
    '63000000-0000-4000-8000-000000000003';
  command_d uuid :=
    '63000000-0000-4000-8000-000000000004';
  command_e uuid :=
    '63000000-0000-4000-8000-000000000005';
  email_value text := 'attempt-authority@example.test';
  canonical_request text;
  request_hash_value text;
  claim_a jsonb;
  claim_b jsonb;
  claim_c jsonb;
  claim_d jsonb;
  claim_e jsonb;
  blocked_receipt jsonb;
  attempt_state jsonb;
  attempt_id_value uuid;
begin
  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', company_id_value,
    'commandId', command_a,
    'action', 'invite',
    'email', email_value,
    'role', 'dispatcher',
    'customerId', null
  )::text;
  request_hash_value := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    company_id_value,
    owner_id_value,
    command_a,
    'invite',
    email_value,
    'dispatcher',
    null,
    canonical_request,
    request_hash_value
  );
  claim_a := private.claim_storyops_identity_invitation_attempt(
    company_id_value,
    owner_id_value,
    command_a,
    request_hash_value
  );

  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', company_id_value,
    'commandId', command_b,
    'action', 'invite',
    'email', email_value,
    'role', 'technician',
    'customerId', null
  )::text;
  request_hash_value := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    company_id_value,
    owner_id_value,
    command_b,
    'invite',
    email_value,
    'technician',
    null,
    canonical_request,
    request_hash_value
  );
  claim_b := private.claim_storyops_identity_invitation_attempt(
    company_id_value,
    owner_id_value,
    command_b,
    request_hash_value
  );
  blocked_receipt := public.record_storyops_identity_invite_blocked(
    company_id_value,
    owner_id_value,
    command_b,
    request_hash_value
  );

  select invitation_attempt_id
  into attempt_id_value
  from public.identity_provisioning_commands
  where company_id = company_id_value
    and command_id = command_a;

  if claim_a ->> 'attemptAlreadyAuthorized' <> 'false'
    or claim_b ->> 'attemptAlreadyAuthorized' <> 'true'
    or blocked_receipt ->> 'deliveryStatus'
      <> 'provider_submission_unknown'
    or (
      select count(*)
      from public.identity_invitation_attempts attempt
      where attempt.company_id = company_id_value
        and attempt.normalized_email = email_value
    ) <> 1
    or (
      select count(distinct command.invitation_attempt_id)
      from public.identity_provisioning_commands command
      where command.company_id = company_id_value
        and command.command_id in (command_a, command_b)
    ) <> 1
    or (
      select count(*)
      from public.identity_provisioning_targets target
      where target.company_id = company_id_value
        and target.normalized_email = email_value
    ) <> 0
  then
    raise exception
      'Different commands did not share one non-destructive provider authority';
  end if;

  perform public.record_storyops_identity_observation(
    company_id_value,
    owner_id_value,
    command_a,
    claim_a ->> 'requestHash',
    null,
    'pending',
    'provider_submission_unknown',
    'invite_submission_unknown'
  );
  attempt_state :=
    public.load_storyops_identity_invitation_attempt_state(
      company_id_value,
      owner_id_value
    );
  if attempt_state #>> '{unresolvedAttempts,0,email}' <> email_value
    or attempt_state #>> '{unresolvedAttempts,0,authorityStatus}'
      <> 'provider_submission_unknown'
    or attempt_state #>> '{unresolvedAttempts,0,retryEligible}'
      <> 'false'
    or attempt_state #>> '{unresolvedAttempts,0,providerCommandId}'
      <> command_a::text
  then
    raise exception
      'The owner could not observe unresolved provider authority safely: %',
      attempt_state;
  end if;

  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', company_id_value,
    'commandId', command_c,
    'action', 'invite',
    'email', email_value,
    'role', 'technician',
    'customerId', null
  )::text;
  request_hash_value := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    company_id_value,
    owner_id_value,
    command_c,
    'invite',
    email_value,
    'technician',
    null,
    canonical_request,
    request_hash_value
  );
  claim_c := private.claim_storyops_identity_invitation_attempt(
    company_id_value,
    owner_id_value,
    command_c,
    request_hash_value
  );
  perform public.record_storyops_identity_invite_blocked(
    company_id_value,
    owner_id_value,
    command_c,
    request_hash_value
  );

  if claim_c ->> 'attemptAlreadyAuthorized' <> 'true'
    or (
      select status
      from public.identity_invitation_attempts
      where id = attempt_id_value
    ) <> 'provider_submission_unknown'
    or (
      select count(*)
      from public.audit_events event
      where event.company_id = company_id_value
        and event.action = 'identity.invite.attempt.authorized'
        and event.entity_id = attempt_id_value
    ) <> 1
  then
    raise exception
      'Unknown provider truth did not remain a single blocking authority';
  end if;

  update public.identity_invitation_attempts
  set
    authorized_at = clock_timestamp() - interval '8 days',
    expires_at = clock_timestamp() - interval '1 day'
  where id = attempt_id_value;

  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', company_id_value,
    'commandId', command_d,
    'action', 'invite',
    'email', email_value,
    'role', 'technician',
    'customerId', null
  )::text;
  request_hash_value := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    company_id_value,
    owner_id_value,
    command_d,
    'invite',
    email_value,
    'technician',
    null,
    canonical_request,
    request_hash_value
  );
  claim_d := private.claim_storyops_identity_invitation_attempt(
    company_id_value,
    owner_id_value,
    command_d,
    request_hash_value
  );

  if claim_d ->> 'attemptAlreadyAuthorized' <> 'false'
    or (
      select status
      from public.identity_invitation_attempts
      where id = attempt_id_value
    ) <> 'expired'
    or (
      select count(*)
      from public.identity_invitation_attempts attempt
      where attempt.company_id = company_id_value
        and attempt.normalized_email = email_value
        and attempt.status = 'pending'
    ) <> 1
  then
    raise exception
      'Only deterministic authority expiry may release the target';
  end if;

  perform public.record_storyops_identity_observation(
    company_id_value,
    owner_id_value,
    command_d,
    request_hash_value,
    null,
    'pending',
    'provider_submission_failed',
    'invite_submission_failed'
  );

  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', company_id_value,
    'commandId', command_e,
    'action', 'invite',
    'email', email_value,
    'role', 'technician',
    'customerId', null
  )::text;
  request_hash_value := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    company_id_value,
    owner_id_value,
    command_e,
    'invite',
    email_value,
    'technician',
    null,
    canonical_request,
    request_hash_value
  );
  claim_e := private.claim_storyops_identity_invitation_attempt(
    company_id_value,
    owner_id_value,
    command_e,
    request_hash_value
  );
  if claim_e ->> 'attemptAlreadyAuthorized' <> 'false'
    or (
      select count(*)
      from public.identity_invitation_attempts attempt
      where attempt.company_id = company_id_value
        and attempt.normalized_email = email_value
        and attempt.status = 'provider_submission_failed'
    ) <> 1
  then
    raise exception
      'A known provider rejection did not release the target';
  end if;
end;
$$;

\echo '3/3 trusted exact-directory observation explicitly reconciles the authority'
do $$
declare
  company_id_value uuid :=
    '10000000-0000-4000-8000-000000000001';
  owner_id_value uuid :=
    '10000000-0000-4000-8000-000000000101';
  command_a uuid :=
    '63000000-0000-4000-8000-000000000011';
  command_b uuid :=
    '63000000-0000-4000-8000-000000000012';
  command_c uuid :=
    '63000000-0000-4000-8000-000000000013';
  email_value text;
  canonical_request text;
  request_hash_value text;
  attempt_id_value uuid;
  blocked_claim jsonb;
begin
  select lower(btrim(user_row.email))
  into email_value
  from auth.users user_row
  where user_row.id = owner_id_value;
  if email_value is null then
    raise exception 'The seeded owner identity is unavailable';
  end if;

  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', company_id_value,
    'commandId', command_a,
    'action', 'invite',
    'email', email_value,
    'role', 'dispatcher',
    'customerId', null
  )::text;
  request_hash_value := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    company_id_value,
    owner_id_value,
    command_a,
    'invite',
    email_value,
    'dispatcher',
    null,
    canonical_request,
    request_hash_value
  );
  perform private.claim_storyops_identity_invitation_attempt(
    company_id_value,
    owner_id_value,
    command_a,
    request_hash_value
  );
  perform public.record_storyops_identity_observation(
    company_id_value,
    owner_id_value,
    command_a,
    request_hash_value,
    owner_id_value,
    'invited',
    'provider_submission_accepted',
    'invite_submission_accepted'
  );

  select invitation_attempt_id
  into attempt_id_value
  from public.identity_provisioning_commands
  where company_id = company_id_value
    and command_id = command_a;

  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', company_id_value,
    'commandId', command_b,
    'action', 'invite',
    'email', email_value,
    'role', 'dispatcher',
    'customerId', null
  )::text;
  request_hash_value := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    company_id_value,
    owner_id_value,
    command_b,
    'invite',
    email_value,
    'dispatcher',
    null,
    canonical_request,
    request_hash_value
  );
  blocked_claim := private.claim_storyops_identity_invitation_attempt(
    company_id_value,
    owner_id_value,
    command_b,
    request_hash_value
  );
  if blocked_claim ->> 'attemptAlreadyAuthorized' <> 'true'
    or (
      select status
      from public.identity_invitation_attempts
      where id = attempt_id_value
    ) <> 'provider_submission_accepted'
  then
    raise exception
      'Accepted provider truth did not block a second command';
  end if;
  perform public.record_storyops_identity_invite_blocked(
    company_id_value,
    owner_id_value,
    command_b,
    request_hash_value
  );
  if not exists (
    select 1
    from public.identity_provisioning_targets target
    where target.company_id = company_id_value
      and target.normalized_email = email_value
      and target.target_role = 'dispatcher'
      and target.status = 'invited'
      and target.delivery_status = 'provider_submission_accepted'
      and target.target_user_id = owner_id_value
  ) then
    raise exception
      'A blocked command overwrote accepted target truth';
  end if;

  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', company_id_value,
    'commandId', command_c,
    'action', 'invite',
    'email', email_value,
    'role', 'dispatcher',
    'customerId', null
  )::text;
  request_hash_value := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    company_id_value,
    owner_id_value,
    command_c,
    'invite',
    email_value,
    'dispatcher',
    null,
    canonical_request,
    request_hash_value
  );
  perform public.record_storyops_identity_observation(
    company_id_value,
    owner_id_value,
    command_c,
    request_hash_value,
    owner_id_value,
    'pending',
    'not_requested',
    'existing_identity_requires_link'
  );

  if (
    select status
    from public.identity_invitation_attempts
    where id = attempt_id_value
  ) <> 'reconciled'
    or (
      select reconciliation_basis
      from public.identity_invitation_attempts
      where id = attempt_id_value
    ) <> 'directory_identity_observed'
  then
    raise exception
      'Exact trusted directory evidence did not reconcile the authority';
  end if;
end;
$$;

rollback;
