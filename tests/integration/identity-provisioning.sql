\set ON_ERROR_STOP on

begin;

\echo '1/8 identity tables and service RPCs are not browser mutation surfaces'
do $$
begin
  if has_table_privilege(
    'authenticated',
    'public.identity_provisioning_targets',
    'SELECT,INSERT,UPDATE,DELETE'
  ) or has_table_privilege(
    'authenticated',
    'public.identity_provisioning_commands',
    'SELECT,INSERT,UPDATE,DELETE'
  ) or has_table_privilege(
    'authenticated',
    'public.company_memberships',
    'INSERT,UPDATE,DELETE'
  ) or has_table_privilege(
    'authenticated',
    'public.customer_portal_users',
    'INSERT,UPDATE,DELETE'
  ) or has_function_privilege(
    'authenticated',
    'public.begin_storyops_identity_provisioning(uuid,uuid,uuid,text,text,text,uuid,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.link_storyops_identity(uuid,uuid,uuid,text,uuid)',
    'EXECUTE'
  ) then
    raise exception 'A browser role retained an identity provisioning mutation surface';
  end if;
end;
$$;

\echo '2/8 a SQL role without the service JWT claim fails closed'
set local role service_role;
do $$
declare
  denied boolean := false;
begin
  begin
    perform public.load_storyops_identity_provisioning_state(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101'
    );
  exception when others then
    denied := sqlerrm = 'IDENTITY_SERVICE_ROLE_REQUIRED';
  end;
  if not denied then
    raise exception 'SQL role alone bypassed the identity service boundary';
  end if;
end;
$$;
reset role;

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '46000000-0000-4000-8000-000000000101',
    'authenticated',
    'authenticated',
    'field.identity@example.test',
    extensions.crypt('LocalIdentity1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Field Identity"}',
    now(), now(), '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '46000000-0000-4000-8000-000000000102',
    'authenticated',
    'authenticated',
    'invited.identity@example.test',
    extensions.crypt('LocalIdentity1!', extensions.gen_salt('bf')),
    null,
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Invited Identity"}',
    now(), now(), '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '46000000-0000-4000-8000-000000000103',
    'authenticated',
    'authenticated',
    'portal.identity@example.test',
    extensions.crypt('LocalIdentity1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Portal Identity"}',
    now(), now(), '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '46000000-0000-4000-8000-000000000104',
    'authenticated',
    'authenticated',
    'race.identity@example.test',
    extensions.crypt('LocalIdentity1!', extensions.gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{"full_name":"Race Identity"}',
    now(), now(), '', '', '', ''
  );

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

\echo '3/8 a confirmed exact email links once and full-request idempotency is enforced'
do $$
declare
  canonical_request text;
  request_hash text;
  receipt jsonb;
  replay jsonb;
  conflict_blocked boolean := false;
begin
  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'commandId', '46000000-0000-4000-8000-000000000001'::uuid,
    'action', 'link',
    'email', 'field.identity@example.test',
    'role', 'technician',
    'customerId', null
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000001',
    'link',
    'field.identity@example.test',
    'technician',
    null,
    canonical_request,
    request_hash
  );
  receipt := public.link_storyops_identity(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000001',
    request_hash,
    '46000000-0000-4000-8000-000000000101'
  );
  replay := public.begin_storyops_identity_provisioning(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000001',
    'link',
    'field.identity@example.test',
    'technician',
    null,
    canonical_request,
    request_hash
  );
  if receipt ->> 'status' <> 'linked'
    or not (receipt ->> 'membershipActive')::boolean
    or (receipt ->> 'portalLinked')::boolean
    or (receipt ->> 'externalDeliveryClaimed')::boolean
    or not (replay ->> 'replayed')::boolean
  then
    raise exception 'Exact technician link/replay was invalid: %, %',
      receipt, replay;
  end if;

  begin
    perform public.begin_storyops_identity_provisioning(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '46000000-0000-4000-8000-000000000001',
      'link',
      'different.identity@example.test',
      'technician',
      null,
      replace(
        canonical_request,
        'field.identity@example.test',
        'different.identity@example.test'
      ),
      encode(
        extensions.digest(
          convert_to(
            replace(
              canonical_request,
              'field.identity@example.test',
              'different.identity@example.test'
            ),
            'UTF8'
          ),
          'sha256'
        ),
        'hex'
      )
    );
  exception when others then
    conflict_blocked := sqlerrm = 'IDENTITY_IDEMPOTENCY_CONFLICT';
  end;
  if not conflict_blocked then
    raise exception 'A changed request reused an identity command ID';
  end if;
end;
$$;

\echo '4/8 invitation without provider and launch authority stays disabled without claiming delivery or access'
do $$
declare
  canonical_request text;
  request_hash text;
  authority_blocked boolean := false;
  replay_context jsonb;
  receipt jsonb;
begin
  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'commandId', '46000000-0000-4000-8000-000000000002'::uuid,
    'action', 'invite',
    'email', 'invited.identity@example.test',
    'role', 'dispatcher',
    'customerId', null
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000002',
    'invite',
    'invited.identity@example.test',
    'dispatcher',
    null,
    canonical_request,
    request_hash
  );
  begin
    perform public.authorize_storyops_identity_invite(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '46000000-0000-4000-8000-000000000002',
      request_hash,
      repeat('a', 64)
    );
  exception when others then
    authority_blocked := sqlerrm in (
      'PROVIDER_INVOCATION_ENVIRONMENT_NOT_READY',
      'PROVIDER_INVOCATION_NOT_AUTHORIZED',
      'PROVIDER_INVOCATION_LAUNCH_NOT_AUTHORIZED'
    );
  end;
  if not authority_blocked then
    raise exception 'An invitation attempt bypassed provider/launch authority';
  end if;
  replay_context := public.begin_storyops_identity_provisioning(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000002',
    'invite',
    'invited.identity@example.test',
    'dispatcher',
    null,
    canonical_request,
    request_hash
  );
  receipt := public.record_storyops_identity_observation(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000002',
    request_hash,
    null,
    'pending',
    'disabled',
    'invite_delivery_disabled'
  );
  if (replay_context ->> 'inviteAttemptAuthorized')::boolean
    or receipt ->> 'status' <> 'pending'
    or receipt ->> 'deliveryStatus' <> 'disabled'
    or (receipt ->> 'externalDeliveryClaimed')::boolean
    or (receipt ->> 'membershipActive')::boolean
  then
    raise exception 'Disabled invite truth overclaimed delivery or access: %',
      receipt;
  end if;
end;
$$;

\echo '5/8 exact customer link and revoke update both portal mapping and membership'
do $$
declare
  link_request text;
  link_hash text;
  revoke_request text;
  revoke_hash text;
  linked jsonb;
  revoked jsonb;
  state_after_link jsonb;
  state_after_revoke jsonb;
begin
  link_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'commandId', '46000000-0000-4000-8000-000000000003'::uuid,
    'action', 'link',
    'email', 'portal.identity@example.test',
    'role', 'customer',
    'customerId', '10000000-0000-4000-8000-000000000201'::uuid
  )::text;
  link_hash := encode(
    extensions.digest(convert_to(link_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000003',
    'link',
    'portal.identity@example.test',
    'customer',
    '10000000-0000-4000-8000-000000000201',
    link_request,
    link_hash
  );
  linked := public.link_storyops_identity(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000003',
    link_hash,
    '46000000-0000-4000-8000-000000000103'
  );
  state_after_link := public.load_storyops_identity_provisioning_state(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101'
  );
  if linked ->> 'status' <> 'linked'
    or not (linked ->> 'portalLinked')::boolean
    or not exists (
      select 1
      from jsonb_array_elements(state_after_link -> 'targets') target
      where target ->> 'email' = 'portal.identity@example.test'
        and (target ->> 'membershipActive')::boolean
        and (target ->> 'portalLinked')::boolean
    )
  then
    raise exception 'Customer portal identity was not exactly linked: %', linked;
  end if;

  revoke_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'commandId', '46000000-0000-4000-8000-000000000004'::uuid,
    'action', 'revoke',
    'email', 'portal.identity@example.test',
    'role', 'customer',
    'customerId', '10000000-0000-4000-8000-000000000201'::uuid
  )::text;
  revoke_hash := encode(
    extensions.digest(convert_to(revoke_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000004',
    'revoke',
    'portal.identity@example.test',
    'customer',
    '10000000-0000-4000-8000-000000000201',
    revoke_request,
    revoke_hash
  );
  revoked := public.revoke_storyops_identity(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000004',
    revoke_hash,
    '46000000-0000-4000-8000-000000000103'
  );
  state_after_revoke := public.load_storyops_identity_provisioning_state(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101'
  );
  if revoked ->> 'status' <> 'revoked'
    or (revoked ->> 'portalLinked')::boolean
    or (revoked ->> 'membershipActive')::boolean
    or exists (
      select 1
      from jsonb_array_elements(state_after_revoke -> 'targets') target
      where target ->> 'email' = 'portal.identity@example.test'
        and (
          (target ->> 'membershipActive')::boolean
          or (target ->> 'portalLinked')::boolean
          or target ->> 'status' <> 'revoked'
        )
    )
  then
    raise exception 'Customer portal revocation was incomplete: %', revoked;
  end if;
end;
$$;

\echo '6/8 dispatcher and cross-tenant actors cannot provision identities'
do $$
declare
  canonical_request text;
  request_hash text;
  dispatcher_denied boolean := false;
  cross_tenant_denied boolean := false;
begin
  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'commandId', '46000000-0000-4000-8000-000000000005'::uuid,
    'action', 'link',
    'email', 'race.identity@example.test',
    'role', 'technician',
    'customerId', null
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  begin
    perform public.begin_storyops_identity_provisioning(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000102',
      '46000000-0000-4000-8000-000000000005',
      'link',
      'race.identity@example.test',
      'technician',
      null,
      canonical_request,
      request_hash
    );
  exception when others then
    dispatcher_denied := sqlerrm = 'IDENTITY_ACTIVE_OWNER_REQUIRED';
  end;
  begin
    perform public.begin_storyops_identity_provisioning(
      '10000000-0000-4000-8000-000000000001',
      '46000000-0000-4000-8000-000000000101',
      '46000000-0000-4000-8000-000000000005',
      'link',
      'race.identity@example.test',
      'technician',
      null,
      canonical_request,
      request_hash
    );
  exception when others then
    cross_tenant_denied := sqlerrm = 'IDENTITY_ACTIVE_OWNER_REQUIRED';
  end;
  if not dispatcher_denied or not cross_tenant_denied then
    raise exception 'A dispatcher or cross-tenant actor crossed the identity boundary';
  end if;
end;
$$;

\echo '7/8 pausing after request creation blocks the final access mutation'
do $$
declare
  canonical_request text;
  request_hash text;
begin
  canonical_request := jsonb_build_object(
    'schemaVersion', 'storyops-identity-provisioning-request-v1',
    'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
    'commandId', '46000000-0000-4000-8000-000000000006'::uuid,
    'action', 'link',
    'email', 'race.identity@example.test',
    'role', 'technician',
    'customerId', null
  )::text;
  request_hash := encode(
    extensions.digest(convert_to(canonical_request, 'UTF8'), 'sha256'),
    'hex'
  );
  perform public.begin_storyops_identity_provisioning(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101',
    '46000000-0000-4000-8000-000000000006',
    'link',
    'race.identity@example.test',
    'technician',
    null,
    canonical_request,
    request_hash
  );
end;
$$;
reset role;
update public.companies
set status = 'paused'
where id = '10000000-0000-4000-8000-000000000001';
set local role service_role;
do $$
declare
  request_hash text;
  mutation_denied boolean := false;
begin
  -- The service role cannot read the base table; rebuild the exact test hash.
  request_hash := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'schemaVersion', 'storyops-identity-provisioning-request-v1',
          'companyId', '10000000-0000-4000-8000-000000000001'::uuid,
          'commandId', '46000000-0000-4000-8000-000000000006'::uuid,
          'action', 'link',
          'email', 'race.identity@example.test',
          'role', 'technician',
          'customerId', null
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  begin
    perform public.link_storyops_identity(
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000101',
      '46000000-0000-4000-8000-000000000006',
      request_hash,
      '46000000-0000-4000-8000-000000000104'
    );
  exception when others then
    mutation_denied := sqlerrm = 'IDENTITY_ACTIVE_OWNER_REQUIRED';
  end;
  if not mutation_denied then
    raise exception 'Paused-company race granted identity access';
  end if;
end;
$$;
reset role;
do $$
begin
  if exists (
    select 1
    from public.company_memberships membership
    where membership.company_id =
      '10000000-0000-4000-8000-000000000001'
      and membership.user_id =
        '46000000-0000-4000-8000-000000000104'
  ) then
    raise exception 'Paused-company race persisted a membership';
  end if;
end;
$$;
update public.companies
set status = 'active'
where id = '10000000-0000-4000-8000-000000000001';
set local role service_role;

\echo '8/8 owner state is tenant-scoped and audit evidence preserves delivery truth'
do $$
declare
  state jsonb;
begin
  state := public.load_storyops_identity_provisioning_state(
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000101'
  );
  if state ->> 'companyId' <>
      '10000000-0000-4000-8000-000000000001'
    or state ->> 'companyStatus' <> 'active'
    or jsonb_array_length(state -> 'targets') <> 3
  then
    raise exception 'Identity state or audit delivery truth was invalid: %', state;
  end if;
end;
$$;

reset role;
do $$
begin
  if exists (
    select 1
    from public.audit_events event
    where event.company_id =
      '10000000-0000-4000-8000-000000000001'
      and event.entity_type = 'identity_provisioning_target'
      and coalesce(
        (event.after_data ->> 'externalDeliveryClaimed')::boolean,
        false
      )
  ) or not exists (
    select 1
    from public.audit_events event
    where event.company_id =
      '10000000-0000-4000-8000-000000000001'
      and event.action = 'identity.provisioning.pending'
      and event.after_data ->> 'deliveryStatus' =
        'disabled'
      and event.after_data ->> 'outcomeCode' =
        'invite_delivery_disabled'
  ) then
    raise exception 'Identity audit evidence overclaimed external delivery';
  end if;
end;
$$;
rollback;
