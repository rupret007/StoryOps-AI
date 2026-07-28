-- StoryOps authenticated, normalized, idempotent command boundary.
-- This is intentionally a finite command vocabulary rather than a generic JSON
-- row overwrite. Roles and assignment are derived from auth.uid() on every call.

alter table public.materials
  add column requires_sds boolean not null default true;

alter table public.incidents
  add column closure_note text;

alter table public.incidents
  add constraint incidents_closure_note_length
  check (
    closure_note is null
    or char_length(btrim(closure_note)) between 5 and 2000
  );

create or replace function public.execute_storyops_command(
  p_company_id uuid,
  p_command_id uuid,
  p_command_type text,
  p_expected_version integer,
  p_payload jsonb,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
  effective_request_hash text;
  reservation public.idempotency_keys%rowtype;
  inserted_reservation_id uuid;
  command_entity_id uuid;
  visit_id_value uuid;
  visit_job_id_value uuid;
  visit_property_id_value uuid;
  job_id_value uuid;
  incident_id_value uuid;
  customer_id_value uuid;
  property_id_value uuid;
  template_item_id_value uuid;
  material_id_value uuid;
  asset_id_value uuid;
  target_status text;
  current_status text;
  current_version integer;
  resulting_version integer;
  result jsonb;
  started_at_value timestamptz;
  ended_at_value timestamptz;
  recorded_at_value timestamptz;
  captured_at_value timestamptz;
  accepted_at_value timestamptz;
  notes_value text;
  closure_note_value text;
  evidence_ids uuid[];
begin
  if actor_user_id is null then
    raise exception 'Authentication is required';
  end if;
  if p_command_type is null or p_command_type not in (
    'lead.create', 'lead.qualify', 'lead.link_scope', 'customer.create', 'property.create',
    'quote.send', 'quote.accept', 'visit.transition', 'visit.notes.update', 'checklist.record',
    'time.start', 'time.stop', 'material.record', 'media.register',
    'signature.capture', 'incident.report', 'incident.close', 'notification.read',
    'approval.decide'
  ) then
    raise exception 'Unsupported StoryOps command type';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Command payload must be a JSON object';
  end if;
  if p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Request hash must be lowercase SHA-256';
  end if;
  effective_request_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'commandType', p_command_type,
        'expectedVersion', p_expected_version,
        'payload', p_payload
      )::text,
      'sha256'
    ),
    'hex'
  );
  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role is null then
    raise exception 'No active company membership';
  end if;

  insert into public.idempotency_keys(
    company_id, scope, key, request_hash, expires_at
  )
  values (
    p_company_id,
    'workspace-command-v1',
    p_command_id::text,
    effective_request_hash,
    now() + interval '90 days'
  )
  on conflict (company_id, scope, key) do nothing
  returning id into inserted_reservation_id;

  if inserted_reservation_id is null then
    select *
    into reservation
    from public.idempotency_keys
    where company_id = p_company_id
      and scope = 'workspace-command-v1'
      and key = p_command_id::text
    for update;
    if reservation.request_hash <> effective_request_hash then
      raise exception 'Command ID was reused with a different payload';
    end if;
    if reservation.status = 'completed' then
      return reservation.response || jsonb_build_object('replayed', true);
    end if;
    raise exception 'The same command is already in progress';
  end if;

  command_entity_id := nullif(p_payload ->> 'entityId', '')::uuid;

  if p_command_type = 'lead.create' then
    if actor_role not in ('owner', 'dispatcher') or command_entity_id is null then
      raise exception 'Only back office may create a lead with a stable entityId';
    end if;
    insert into public.leads(
      id, company_id, source, status, display_name, email, phone,
      requested_services, preferred_contact_channel, owner_user_id
    )
    values (
      command_entity_id,
      p_company_id,
      p_payload ->> 'source',
      'new',
      nullif(btrim(p_payload ->> 'displayName'), ''),
      nullif(btrim(p_payload ->> 'email'), ''),
      nullif(btrim(p_payload ->> 'phone'), ''),
      array(
        select jsonb_array_elements_text(
          coalesce(p_payload -> 'requestedServices', '[]'::jsonb)
        )
      ),
      nullif(p_payload ->> 'preferredContactChannel', ''),
      actor_user_id
    )
    returning version into resulting_version;

  elsif p_command_type = 'lead.qualify' then
    if actor_role not in ('owner', 'dispatcher') or command_entity_id is null then
      raise exception 'Only back office may qualify a lead';
    end if;
    target_status := p_payload ->> 'status';
    if target_status not in ('qualifying', 'qualified', 'unqualified', 'lost') then
      raise exception 'Invalid lead qualification status';
    end if;
    if target_status = 'unqualified'
      and nullif(btrim(p_payload ->> 'disqualificationReason'), '') is null
    then
      raise exception 'Unqualified leads require a reason';
    end if;
    update public.leads
    set
      status = target_status,
      qualification_summary = nullif(btrim(p_payload ->> 'qualificationSummary'), ''),
      disqualification_reason = case
        when target_status = 'unqualified'
          then nullif(btrim(p_payload ->> 'disqualificationReason'), '')
        else null
      end
    where id = command_entity_id
      and company_id = p_company_id
      and version = p_expected_version
      and status in ('new', 'qualifying', 'qualified')
    returning version into resulting_version;
    if not found then
      raise exception 'Lead version or transition conflict';
    end if;

  elsif p_command_type = 'lead.link_scope' then
    if actor_role not in ('owner', 'dispatcher') or command_entity_id is null then
      raise exception 'Only back office may link a qualified lead';
    end if;
    if exists (
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in ('entityId', 'customerId', 'propertyId')
    ) then
      raise exception 'lead.link_scope contains unsupported fields';
    end if;
    customer_id_value := nullif(p_payload ->> 'customerId', '')::uuid;
    property_id_value := nullif(p_payload ->> 'propertyId', '')::uuid;
    if customer_id_value is null or property_id_value is null then
      raise exception 'Lead scope requires an exact customer and property';
    end if;
    update public.leads lead
    set
      customer_id = customer_id_value,
      property_id = property_id_value,
      status = 'converted'
    where lead.id = command_entity_id
      and lead.company_id = p_company_id
      and lead.version = p_expected_version
      and lead.status = 'qualified'
      and exists (
        select 1
        from public.customers customer
        join public.properties property
          on property.customer_id = customer.id
         and property.company_id = customer.company_id
        where customer.id = customer_id_value
          and customer.company_id = p_company_id
          and customer.lifecycle <> 'blocked'
          and property.id = property_id_value
      )
    returning lead.version into resulting_version;
    if not found then
      raise exception 'Lead, customer, property, status, or version conflict';
    end if;

  elsif p_command_type = 'customer.create' then
    if actor_role not in ('owner', 'dispatcher') or command_entity_id is null then
      raise exception 'Only back office may create a customer';
    end if;
    insert into public.customers(
      id, company_id, kind, display_name, given_name, family_name,
      business_name, email, phone, billing_address, acquisition_source
    )
    values (
      command_entity_id,
      p_company_id,
      coalesce(nullif(p_payload ->> 'kind', ''), 'individual'),
      nullif(btrim(p_payload ->> 'displayName'), ''),
      nullif(btrim(p_payload ->> 'givenName'), ''),
      nullif(btrim(p_payload ->> 'familyName'), ''),
      nullif(btrim(p_payload ->> 'businessName'), ''),
      nullif(btrim(p_payload ->> 'email'), ''),
      nullif(btrim(p_payload ->> 'phone'), ''),
      p_payload -> 'billingAddress',
      nullif(btrim(p_payload ->> 'acquisitionSource'), '')
    )
    returning version into resulting_version;

  elsif p_command_type = 'property.create' then
    if actor_role not in ('owner', 'dispatcher') or command_entity_id is null then
      raise exception 'Only back office may create a property';
    end if;
    customer_id_value := nullif(p_payload ->> 'customerId', '')::uuid;
    if jsonb_typeof(p_payload -> 'serviceAddress') <> 'object' then
      raise exception 'Property serviceAddress must be an object';
    end if;
    insert into public.properties(
      id, company_id, customer_id, name, property_type, service_address,
      access_instructions, water_source_notes, drainage_notes, known_hazards,
      stories
    )
    values (
      command_entity_id,
      p_company_id,
      customer_id_value,
      nullif(btrim(p_payload ->> 'name'), ''),
      coalesce(nullif(p_payload ->> 'propertyType', ''), 'single_family'),
      p_payload -> 'serviceAddress',
      nullif(btrim(p_payload ->> 'accessInstructions'), ''),
      nullif(btrim(p_payload ->> 'waterSourceNotes'), ''),
      nullif(btrim(p_payload ->> 'drainageNotes'), ''),
      array(
        select jsonb_array_elements_text(
          coalesce(p_payload -> 'knownHazards', '[]'::jsonb)
        )
      ),
      nullif(p_payload ->> 'stories', '')::smallint
    )
    returning version into resulting_version;

  elsif p_command_type = 'quote.send' then
    if actor_role not in ('owner', 'dispatcher') or command_entity_id is null then
      raise exception 'Only back office may send a quote';
    end if;
    update public.quotes quote
    set status = 'sent', sent_at = now()
    from public.estimates estimate
    where quote.id = command_entity_id
      and quote.company_id = p_company_id
      and quote.version = p_expected_version
      and quote.status = 'draft'
      and estimate.id = quote.estimate_id
      and estimate.company_id = quote.company_id
      and estimate.status = 'approved'
      and quote.valid_until >= current_date
    returning quote.version into resulting_version;
    if not found then
      raise exception 'Quote is stale, expired, or lacks an approved estimate';
    end if;

  elsif p_command_type = 'quote.accept' then
    if actor_role <> 'customer' or command_entity_id is null then
      raise exception 'Only the mapped portal customer may accept a quote';
    end if;
    accepted_at_value := now();
    update public.quotes quote
    set
      status = 'accepted',
      accepted_at = accepted_at_value,
      accepted_by_name = nullif(btrim(p_payload ->> 'signerName'), ''),
      accepted_by_user_id = actor_user_id,
      acceptance_context_hash = encode(
        extensions.digest(
          concat_ws(
            ':',
            actor_user_id::text,
            quote.id::text,
            quote.terms_version,
            quote.total::text,
            accepted_at_value::text,
            p_command_id::text
          ),
          'sha256'
        ),
        'hex'
      )
    where quote.id = command_entity_id
      and quote.company_id = p_company_id
      and quote.version = p_expected_version
      and quote.status in ('sent', 'viewed')
      and quote.valid_until >= current_date
      and public.is_customer_user(p_company_id, quote.customer_id)
    returning quote.version into resulting_version;
    if not found then
      raise exception 'Quote is stale, expired, or not owned by this portal user';
    end if;

  elsif p_command_type = 'visit.notes.update' then
    if command_entity_id is null then
      raise exception 'visit.notes.update requires entityId';
    end if;
    if exists (
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in ('entityId', 'notes')
    ) then
      raise exception 'Visit notes payload contains unsupported fields';
    end if;
    notes_value := nullif(btrim(p_payload ->> 'notes'), '');
    if notes_value is null or char_length(notes_value) < 5 or char_length(notes_value) > 4000 then
      raise exception 'Visit notes must contain 5 through 4000 characters';
    end if;
    if actor_role not in ('owner', 'dispatcher', 'technician') then
      raise exception 'Role cannot update visit notes';
    end if;
    update public.visits visit
    set
      internal_notes = notes_value,
      offline_revision = visit.offline_revision + 1,
      last_synced_at = now()
    where visit.id = command_entity_id
      and visit.company_id = p_company_id
      and visit.version = p_expected_version
      and visit.status in ('on_site', 'paused')
      and (
        actor_role in ('owner', 'dispatcher')
        or (
          actor_role = 'technician'
          and public.is_assigned_technician_for_visit(visit.id)
        )
      )
    returning visit.version into resulting_version;
    if not found then
      raise exception 'Visit notes version, assignment, or active-state conflict';
    end if;

  elsif p_command_type = 'visit.transition' then
    command_entity_id := coalesce(
      command_entity_id,
      nullif(p_payload ->> 'visitId', '')::uuid
    );
    target_status := p_payload ->> 'status';
    select visit.status, visit.version, visit.job_id
    into current_status, current_version, visit_job_id_value
    from public.visits visit
    where visit.id = command_entity_id and visit.company_id = p_company_id
    for update;
    if not found or current_version is distinct from p_expected_version then
      raise exception 'Visit version conflict';
    end if;
    perform 1
    from public.jobs job
    where job.id = visit_job_id_value
      and job.company_id = p_company_id
    for update;
    if not found then
      raise exception 'Visit job is unavailable';
    end if;
    if actor_role = 'technician'
      and not public.is_assigned_technician_for_visit(command_entity_id)
    then
      raise exception 'Technician is not assigned to this visit';
    elsif actor_role not in ('owner', 'dispatcher', 'technician') then
      raise exception 'Role cannot transition visits';
    end if;
    if (current_status || '>' || target_status) not in (
      'planned>confirmed', 'planned>cancelled', 'planned>weather_hold',
      'confirmed>en_route', 'confirmed>cancelled', 'confirmed>weather_hold',
      'en_route>on_site', 'en_route>paused', 'on_site>paused',
      'on_site>completed', 'paused>on_site', 'paused>completed',
      'weather_hold>planned', 'weather_hold>confirmed', 'weather_hold>cancelled'
    ) then
      raise exception 'Invalid visit status transition';
    end if;
    if actor_role = 'technician' and (current_status || '>' || target_status) not in (
      'confirmed>en_route', 'en_route>on_site', 'en_route>paused',
      'on_site>paused', 'on_site>completed', 'paused>on_site', 'paused>completed'
    ) then
      raise exception 'Technician cannot perform this visit transition';
    end if;
    if target_status = 'completed' then
      if exists (
        select 1
        from public.visits visit
        join public.checklist_template_items template_item
          on template_item.template_id = visit.checklist_template_id
        left join public.visit_checklist_items item
          on item.visit_id = visit.id
          and item.template_item_id = template_item.id
        where visit.id = command_entity_id
          and template_item.required
          and (
            item.id is null
            or item.status not in ('complete', 'not_applicable')
            or (template_item.safety_critical and item.status <> 'complete')
          )
      ) then
        raise exception 'Required or safety-critical checklist work is incomplete';
      end if;
      if not exists (
        select 1 from public.media_assets
        where visit_id = command_entity_id
          and company_id = p_company_id
          and purpose = 'before'
          and sync_state = 'synced'
      ) or not exists (
        select 1 from public.media_assets
        where visit_id = command_entity_id
          and company_id = p_company_id
          and purpose = 'after'
          and sync_state = 'synced'
      ) then
        raise exception 'Before and after evidence are required';
      end if;
      if not exists (
        select 1
        from public.completion_signatures signature
        join public.media_assets media
          on media.id = signature.signature_asset_id
          and media.company_id = signature.company_id
          and media.visit_id = signature.visit_id
        where signature.visit_id = command_entity_id
          and signature.company_id = p_company_id
          and signature.signer_role = 'customer'
          and media.purpose = 'signature'
          and media.sync_state = 'synced'
      ) then
        raise exception 'Customer completion signature is required';
      end if;
      if exists (
        select 1 from public.time_entries
        where visit_id = command_entity_id
          and company_id = p_company_id
          and ended_at is null
      ) then
        raise exception 'All field timers must be stopped before completion';
      end if;
      if not exists (
        select 1
        from public.visits visit
        where visit.id = command_entity_id
          and visit.company_id = p_company_id
          and char_length(btrim(coalesce(visit.internal_notes, ''))) between 5 and 4000
      ) then
        raise exception 'Internal completion notes must contain 5 through 4000 characters';
      end if;
      if not exists (
        select 1
        from public.material_usage usage
        where usage.visit_id = command_entity_id
          and usage.company_id = p_company_id
      ) then
        raise exception 'At least one material usage record is required';
      end if;
      if exists (
        select 1
        from public.incidents incident
        where incident.company_id = p_company_id
          and incident.status in ('open', 'investigating', 'corrective_action')
          and (
            incident.visit_id = command_entity_id
            or incident.job_id = visit_job_id_value
          )
      ) then
        raise exception 'Open incident work must be closed before visit completion';
      end if;
    end if;
    update public.visits
    set
      status = target_status,
      offline_revision = offline_revision + 1,
      last_synced_at = now()
    where id = command_entity_id and version = p_expected_version
    returning version into resulting_version;

  elsif p_command_type = 'checklist.record' then
    visit_id_value := nullif(p_payload ->> 'visitId', '')::uuid;
    template_item_id_value := nullif(p_payload ->> 'templateItemId', '')::uuid;
    target_status := p_payload ->> 'status';
    if target_status not in ('pending', 'complete', 'not_applicable', 'blocked') then
      raise exception 'Invalid checklist status';
    end if;
    if actor_role = 'technician'
      and not public.is_assigned_technician_for_visit(visit_id_value)
    then
      raise exception 'Technician is not assigned to this visit';
    elsif actor_role not in ('owner', 'dispatcher', 'technician') then
      raise exception 'Role cannot record checklist work';
    end if;
    if not exists (
      select 1
      from public.visits visit
      join public.checklist_template_items template_item
        on template_item.template_id = visit.checklist_template_id
      where visit.id = visit_id_value
        and visit.company_id = p_company_id
        and template_item.id = template_item_id_value
        and template_item.company_id = p_company_id
    ) then
      raise exception 'Checklist item does not belong to this visit template';
    end if;
    select item.version
    into current_version
    from public.visit_checklist_items item
    where item.visit_id = visit_id_value
      and item.template_item_id = template_item_id_value
    for update;
    if found and current_version is distinct from p_expected_version then
      raise exception 'Checklist version conflict';
    elsif not found and coalesce(p_expected_version, 0) <> 0 then
      raise exception 'Checklist item does not yet have the expected version';
    end if;
    evidence_ids := array(
      select value::uuid
      from jsonb_array_elements_text(
        coalesce(p_payload -> 'evidenceAssetIds', '[]'::jsonb)
      ) value
    );
    insert into public.visit_checklist_items(
      id, company_id, visit_id, template_item_id, status, value,
      completed_at, completed_by, evidence_asset_ids, note, offline_client_id
    )
    values (
      coalesce(command_entity_id, gen_random_uuid()),
      p_company_id,
      visit_id_value,
      template_item_id_value,
      target_status,
      p_payload -> 'value',
      case when target_status = 'complete'
        then coalesce(nullif(p_payload ->> 'completedAt', '')::timestamptz, now())
        else null
      end,
      case when target_status = 'complete' then actor_user_id else null end,
      evidence_ids,
      nullif(btrim(p_payload ->> 'note'), ''),
      p_command_id::text
    )
    on conflict (visit_id, template_item_id) do update
    set
      status = excluded.status,
      value = excluded.value,
      completed_at = excluded.completed_at,
      completed_by = excluded.completed_by,
      evidence_asset_ids = excluded.evidence_asset_ids,
      note = excluded.note
    returning id, version into command_entity_id, resulting_version;

  elsif p_command_type = 'time.start' then
    if command_entity_id is null then
      raise exception 'time.start requires entityId';
    end if;
    visit_id_value := nullif(p_payload ->> 'visitId', '')::uuid;
    started_at_value := coalesce(
      nullif(p_payload ->> 'startedAt', '')::timestamptz,
      clock_timestamp()
    );
    if started_at_value > now() + interval '5 minutes'
      or started_at_value < now() - interval '7 days'
    then
      raise exception 'Field start time is outside the offline recovery window';
    end if;
    if actor_role = 'technician'
      and not public.is_assigned_technician_for_visit(visit_id_value)
    then
      raise exception 'Technician is not assigned to this visit';
    elsif actor_role not in ('owner', 'dispatcher', 'technician') then
      raise exception 'Role cannot start field time';
    end if;
    perform 1
    from public.visits visit
    where visit.id = visit_id_value
      and visit.company_id = p_company_id
      and visit.status in ('on_site', 'paused')
    for update;
    if not found then
      raise exception 'Field time requires active work on a company visit';
    end if;
    insert into public.time_entries(
      id, company_id, visit_id, user_id, started_at, source, offline_client_id
    )
    values (
      command_entity_id, p_company_id, visit_id_value, actor_user_id,
      started_at_value, 'field_app', p_command_id::text
    )
    returning version into resulting_version;

  elsif p_command_type = 'time.stop' then
    if command_entity_id is null then
      raise exception 'time.stop requires entityId';
    end if;
    ended_at_value := coalesce(
      nullif(p_payload ->> 'endedAt', '')::timestamptz,
      clock_timestamp()
    );
    if ended_at_value > clock_timestamp() + interval '5 minutes'
      or ended_at_value < clock_timestamp() - interval '7 days'
    then
      raise exception 'Field end time is outside the offline recovery window';
    end if;
    update public.time_entries entry
    set ended_at = ended_at_value
    where entry.id = command_entity_id
      and entry.company_id = p_company_id
      and entry.version = p_expected_version
      and entry.ended_at is null
      and ended_at_value > entry.started_at
      and (
        actor_role in ('owner', 'dispatcher')
        or (
          actor_role = 'technician'
          and entry.user_id = actor_user_id
          and public.is_assigned_technician_for_visit(entry.visit_id)
        )
      )
    returning entry.version into resulting_version;
    if not found then raise exception 'Time entry version, ownership, or state conflict'; end if;

  elsif p_command_type = 'material.record' then
    if command_entity_id is null then
      raise exception 'material.record requires entityId';
    end if;
    visit_id_value := nullif(p_payload ->> 'visitId', '')::uuid;
    material_id_value := nullif(p_payload ->> 'materialId', '')::uuid;
    recorded_at_value := coalesce(
      nullif(p_payload ->> 'recordedAt', '')::timestamptz,
      clock_timestamp()
    );
    if recorded_at_value > clock_timestamp() + interval '5 minutes'
      or recorded_at_value < clock_timestamp() - interval '7 days'
    then
      raise exception 'Material timestamp is outside the offline recovery window';
    end if;
    if actor_role = 'technician'
      and not public.is_assigned_technician_for_visit(visit_id_value)
    then
      raise exception 'Technician is not assigned to this visit';
    elsif actor_role not in ('owner', 'dispatcher', 'technician') then
      raise exception 'Role cannot record material use';
    end if;
    perform 1
    from public.visits visit
    where visit.id = visit_id_value
      and visit.company_id = p_company_id
      and visit.status in ('on_site', 'paused')
    for update;
    if not found then
      raise exception 'Material usage requires active work on a company visit';
    end if;
    if not exists (
      select 1
      from public.materials material
      where material.id = material_id_value
        and material.company_id = p_company_id
        and material.active
        and material.unit = p_payload ->> 'unit'
        and (
          not material.requires_sds
          or exists (
            select 1
            from public.sds_documents document
            where document.id = material.sds_document_id
              and document.company_id = p_company_id
          )
        )
    ) then
      raise exception 'Material is unavailable, its unit does not match, or its required SDS is missing';
    end if;
    insert into public.material_usage(
      id, company_id, visit_id, material_id, quantity, unit,
      recorded_at, recorded_by, offline_client_id
    )
    values (
      command_entity_id, p_company_id, visit_id_value, material_id_value,
      (p_payload ->> 'quantity')::numeric,
      p_payload ->> 'unit',
      recorded_at_value,
      actor_user_id,
      p_command_id::text
    );
    resulting_version := 1;

  elsif p_command_type = 'media.register' then
    if command_entity_id is null then
      raise exception 'media.register requires entityId';
    end if;
    visit_id_value := nullif(p_payload ->> 'visitId', '')::uuid;
    job_id_value := nullif(p_payload ->> 'jobId', '')::uuid;
    incident_id_value := nullif(p_payload ->> 'incidentId', '')::uuid;
    property_id_value := nullif(p_payload ->> 'propertyId', '')::uuid;
    captured_at_value := coalesce(
      nullif(p_payload ->> 'capturedAt', '')::timestamptz,
      clock_timestamp()
    );
    if captured_at_value > clock_timestamp() + interval '5 minutes'
      or captured_at_value < clock_timestamp() - interval '30 days'
    then
      raise exception 'Media timestamp is outside the offline recovery window';
    end if;
    if p_payload ->> 'contentType' not in (
      'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
    ) then
      raise exception 'Unsupported job-media content type';
    end if;
    if not public.can_upload_job_media_object(p_payload ->> 'objectPath') then
      raise exception 'Object path is outside the actor upload scope';
    end if;
    if actor_role = 'customer' then
      select property.customer_id
      into customer_id_value
      from public.properties property
      where property.id = property_id_value
        and property.company_id = p_company_id
        and public.is_customer_user(p_company_id, property.customer_id);
      if not found
        or p_payload ->> 'purpose' <> 'scope'
        or p_payload ->> 'objectPath' not like concat(
          p_company_id::text,
          '/customers/',
          customer_id_value::text,
          '/%'
        )
      then
        raise exception 'Portal users may register scope media for their own property only';
      end if;
      visit_id_value := null;
      job_id_value := null;
      incident_id_value := null;
    elsif actor_role = 'technician' then
      if visit_id_value is null
        or not public.is_assigned_technician_for_visit(visit_id_value)
        or p_payload ->> 'objectPath' not like concat(
          p_company_id::text,
          '/visits/',
          visit_id_value::text,
          '/%'
        )
      then
        raise exception 'Technician media must belong to an assigned visit';
      end if;
    elsif actor_role not in ('owner', 'dispatcher') then
      raise exception 'Role cannot register media';
    end if;

    if visit_id_value is not null then
      select visit.job_id, job.property_id
      into visit_job_id_value, visit_property_id_value
      from public.visits visit
      join public.jobs job on job.id = visit.job_id
      where visit.id = visit_id_value
        and visit.company_id = p_company_id
      for update of visit;
      if not found
        or (job_id_value is not null and job_id_value <> visit_job_id_value)
        or (
          property_id_value is not null
          and property_id_value <> visit_property_id_value
        )
      then
        raise exception 'Media visit, job, and property associations disagree';
      end if;
      job_id_value := visit_job_id_value;
      property_id_value := visit_property_id_value;
    elsif job_id_value is not null and not exists (
      select 1
      from public.jobs job
      where job.id = job_id_value
        and job.company_id = p_company_id
        and (
          property_id_value is null
          or property_id_value = job.property_id
        )
    ) then
      raise exception 'Media job and property associations disagree';
    end if;
    if incident_id_value is not null and not exists (
      select 1
      from public.incidents incident
      where incident.id = incident_id_value
        and incident.company_id = p_company_id
        and (
          visit_id_value is null
          or incident.visit_id = visit_id_value
        )
    ) then
      raise exception 'Media incident association disagrees with the visit';
    end if;

    insert into public.media_assets(
      id, company_id, property_id, job_id, visit_id, incident_id, purpose,
      object_path, content_type, byte_size, checksum_sha256, captured_at,
      captured_by, customer_visible, offline_client_id, sync_state
    )
    values (
      command_entity_id,
      p_company_id,
      property_id_value,
      job_id_value,
      visit_id_value,
      incident_id_value,
      p_payload ->> 'purpose',
      p_payload ->> 'objectPath',
      p_payload ->> 'contentType',
      (p_payload ->> 'byteSize')::bigint,
      p_payload ->> 'checksumSha256',
      captured_at_value,
      actor_user_id,
      case
        when actor_role in ('owner', 'dispatcher')
          then coalesce((p_payload ->> 'customerVisible')::boolean, false)
        else false
      end,
      p_command_id::text,
      'synced'
    )
    returning version into resulting_version;

  elsif p_command_type = 'signature.capture' then
    if command_entity_id is null then
      raise exception 'signature.capture requires entityId';
    end if;
    visit_id_value := nullif(p_payload ->> 'visitId', '')::uuid;
    asset_id_value := nullif(p_payload ->> 'signatureAssetId', '')::uuid;
    if char_length(btrim(coalesce(p_payload ->> 'signerName', ''))) not between 2 and 160
      or char_length(btrim(coalesce(p_payload ->> 'disclosureVersion', ''))) not between 1 and 100
    then
      raise exception 'Signature requires a bounded signer name and disclosure version';
    end if;
    if actor_role = 'technician' then
      if p_payload ->> 'signerRole' <> 'customer'
        or not public.is_assigned_technician_for_visit(visit_id_value)
      then
        raise exception 'Technician may capture a customer acknowledgement only for an assigned visit';
      end if;
    elsif actor_role = 'customer' then
      if p_payload ->> 'signerRole' <> 'customer'
        or not exists (
          select 1
          from public.visits visit
          join public.jobs job on job.id = visit.job_id
          where visit.id = visit_id_value
            and visit.company_id = p_company_id
            and public.is_customer_user(p_company_id, job.customer_id)
        )
      then
        raise exception 'Customer may sign only their own visit';
      end if;
    elsif actor_role not in ('owner', 'dispatcher') then
      raise exception 'Role cannot capture signatures';
    end if;
    if not exists (
      select 1 from public.media_assets media
      where media.id = asset_id_value
        and media.company_id = p_company_id
        and media.visit_id = visit_id_value
        and media.purpose = 'signature'
        and media.content_type in ('image/jpeg', 'image/png', 'image/webp')
    ) then
      raise exception 'Signature asset must be an allowed raster image for this visit';
    end if;
    insert into public.completion_signatures(
      id, company_id, visit_id, signer_name, signer_role, signed_at,
      signature_asset_id, disclosure_version
    )
    values (
      command_entity_id, p_company_id, visit_id_value,
      nullif(btrim(p_payload ->> 'signerName'), ''),
      p_payload ->> 'signerRole',
      coalesce(nullif(p_payload ->> 'signedAt', '')::timestamptz, now()),
      asset_id_value,
      nullif(btrim(p_payload ->> 'disclosureVersion'), '')
    );
    resulting_version := 1;

  elsif p_command_type = 'incident.report' then
    if command_entity_id is null then
      raise exception 'incident.report requires entityId';
    end if;
    visit_id_value := nullif(p_payload ->> 'visitId', '')::uuid;
    job_id_value := nullif(p_payload ->> 'jobId', '')::uuid;
    property_id_value := nullif(p_payload ->> 'propertyId', '')::uuid;
    if actor_role = 'technician'
      and visit_id_value is not null
      and not public.is_assigned_technician_for_visit(visit_id_value)
    then
      raise exception 'Technician is not assigned to this visit';
    elsif actor_role not in ('owner', 'dispatcher', 'technician') then
      raise exception 'Role cannot report incidents';
    end if;
    if actor_role = 'technician'
      and visit_id_value is null
      and (job_id_value is not null or property_id_value is not null)
    then
      raise exception 'Unassigned technician incidents cannot reference a job or property';
    end if;
    if visit_id_value is not null then
      select visit.job_id, job.property_id
      into visit_job_id_value, visit_property_id_value
      from public.visits visit
      join public.jobs job on job.id = visit.job_id
      where visit.id = visit_id_value
        and visit.company_id = p_company_id
      for update of visit;
      if not found
        or (job_id_value is not null and job_id_value <> visit_job_id_value)
        or (
          property_id_value is not null
          and property_id_value <> visit_property_id_value
        )
      then
        raise exception 'Incident visit, job, and property associations disagree';
      end if;
      job_id_value := visit_job_id_value;
      property_id_value := visit_property_id_value;
      perform 1
      from public.jobs job
      where job.id = job_id_value
        and job.company_id = p_company_id
      for update;
      if not found then
        raise exception 'Incident job is unavailable';
      end if;
    elsif job_id_value is not null then
      select job.property_id
      into visit_property_id_value
      from public.jobs job
      where job.id = job_id_value
        and job.company_id = p_company_id
      for update;
      if not found
        or (
          property_id_value is not null
          and property_id_value <> visit_property_id_value
        )
      then
        raise exception 'Incident job and property associations disagree';
      end if;
      property_id_value := visit_property_id_value;
    end if;
    insert into public.incidents(
      id, company_id, incident_number, job_id, visit_id, property_id,
      severity, status, category, occurred_at, reported_at, reported_by,
      summary, immediate_actions, requires_legal_review, retain_until
    )
    values (
      command_entity_id,
      p_company_id,
      nullif(btrim(p_payload ->> 'incidentNumber'), ''),
      job_id_value,
      visit_id_value,
      property_id_value,
      p_payload ->> 'severity',
      'open',
      p_payload ->> 'category',
      coalesce(nullif(p_payload ->> 'occurredAt', '')::timestamptz, now()),
      now(),
      actor_user_id,
      nullif(btrim(p_payload ->> 'summary'), ''),
      nullif(btrim(p_payload ->> 'immediateActions'), ''),
      (
        coalesce((p_payload ->> 'requiresLegalReview')::boolean, false)
        or p_payload ->> 'severity' in ('serious', 'critical')
      ),
      null
    )
    returning version into resulting_version;

  elsif p_command_type = 'incident.close' then
    if command_entity_id is null then
      raise exception 'incident.close requires entityId';
    end if;
    if exists (
      select 1
      from jsonb_object_keys(p_payload) payload_key
      where payload_key not in ('entityId', 'closureNote')
    ) then
      raise exception 'Incident closure payload contains unsupported fields';
    end if;
    if actor_role <> 'owner' then
      raise exception 'Only an owner may close an incident';
    end if;
    closure_note_value := nullif(btrim(p_payload ->> 'closureNote'), '');
    if closure_note_value is null
      or char_length(closure_note_value) < 5
      or char_length(closure_note_value) > 2000
    then
      raise exception 'Incident closure note must contain 5 through 2000 characters';
    end if;
    select incident.status, incident.version
    into current_status, current_version
    from public.incidents incident
    where incident.id = command_entity_id
      and incident.company_id = p_company_id
    for update;
    if not found
      or current_version is distinct from p_expected_version
      or current_status not in ('open', 'investigating', 'corrective_action')
    then
      raise exception 'Incident version or closure state conflict';
    end if;
    update public.incidents incident
    set
      status = 'closed',
      closure_note = closure_note_value,
      closed_at = clock_timestamp(),
      closed_by = actor_user_id
    where incident.id = command_entity_id
      and incident.company_id = p_company_id
      and incident.version = p_expected_version
      and incident.status in ('open', 'investigating', 'corrective_action')
    returning incident.version into resulting_version;
    if not found then
      raise exception 'Incident version or closure state conflict';
    end if;

  elsif p_command_type = 'notification.read' then
    if command_entity_id is null then
      raise exception 'notification.read requires entityId';
    end if;
    update public.notifications notification
    set read_at = coalesce(notification.read_at, now())
    where notification.id = command_entity_id
      and notification.company_id = p_company_id
      and notification.version = p_expected_version
      and (
        notification.recipient_user_id = actor_user_id
        or (
          notification.recipient_customer_id is not null
          and public.is_customer_user(
            p_company_id,
            notification.recipient_customer_id
          )
        )
      )
    returning notification.version into resulting_version;
    if not found then raise exception 'Notification version or ownership conflict'; end if;

  elsif p_command_type = 'approval.decide' then
    if actor_role <> 'owner' or command_entity_id is null then
      raise exception 'Only an owner may decide approvals';
    end if;
    target_status := p_payload ->> 'decision';
    if target_status not in ('approved', 'rejected') then
      raise exception 'Approval decision must be approved or rejected';
    end if;
    update public.approval_requests approval
    set
      status = target_status::public.approval_status,
      decided_by = actor_user_id,
      decided_at = now(),
      decision_note = nullif(btrim(p_payload ->> 'decisionNote'), '')
    where approval.id = command_entity_id
      and approval.company_id = p_company_id
      and approval.version = p_expected_version
      and approval.status = 'pending'
      and (approval.expires_at is null or approval.expires_at > now())
    returning approval.version into resulting_version;
    if not found then raise exception 'Approval is stale, expired, or already decided'; end if;
  end if;

  result := jsonb_build_object(
    'commandId', p_command_id,
    'commandType', p_command_type,
    'status', 'applied',
    'replayed', false,
    'entityId', command_entity_id,
    'version', resulting_version,
    'requestHash', effective_request_hash,
    'serverTime', now()
  );
  update public.idempotency_keys
  set status = 'completed', response = result, completed_at = now()
  where id = inserted_reservation_id and status = 'in_progress';
  if not found then
    raise exception 'Command idempotency reservation was lost';
  end if;
  return result;
end;
$$;

revoke all on function public.execute_storyops_command(
  uuid, uuid, text, integer, jsonb, text
) from public, anon;
grant execute on function public.execute_storyops_command(
  uuid, uuid, text, integer, jsonb, text
) to authenticated;

comment on function public.execute_storyops_command(
  uuid, uuid, text, integer, jsonb, text
) is
  'Authenticated normalized StoryOps command boundary with DB-derived RBAC, assignment checks, optimistic versions, atomic idempotency, and offline command IDs.';

create or replace function public.get_storyops_field_reference(p_company_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role public.app_role;
begin
  if actor_user_id is null then
    raise exception 'Authentication is required';
  end if;
  select membership.role
  into actor_role
  from public.company_memberships membership
  where membership.company_id = p_company_id
    and membership.user_id = actor_user_id
    and membership.active;
  if actor_role is null
    or actor_role not in ('owner', 'dispatcher', 'technician')
  then
    raise exception 'Role cannot read field safety references';
  end if;

  return jsonb_build_object(
    'materials',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', material.id,
            'name', material.name,
            'unit', material.unit,
            'requiresSds', material.requires_sds,
            'version', material.version,
            'sdsDocument',
            case
              when document.id is null then null
              else jsonb_build_object(
                'id', document.id,
                'productName', document.product_name,
                'manufacturer', document.manufacturer,
                'revisionDate', document.revision_date,
                'reviewedAt', document.reviewed_at,
                'checksumSha256', document.checksum_sha256,
                'storageObjectPath', document.storage_object_path,
                'version', document.version
              )
            end
          )
          order by material.name
        )
        from public.materials material
        left join public.sds_documents document
          on document.id = material.sds_document_id
          and document.company_id = material.company_id
        where material.company_id = p_company_id
          and material.active
      ),
      '[]'::jsonb
    ),
    'checklistDefinitions',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', item.id,
            'templateId', item.template_id,
            'label', item.label,
            'itemKind', item.item_kind,
            'required', item.required,
            'safetyCritical', item.safety_critical,
            'sortOrder', item.sort_order
          )
          order by item.template_id, item.sort_order
        )
        from public.checklist_template_items item
        where item.company_id = p_company_id
          and (
            actor_role in ('owner', 'dispatcher')
            or exists (
              select 1
              from public.visits visit
              where visit.company_id = p_company_id
                and visit.checklist_template_id = item.template_id
                and public.is_assigned_technician_for_visit(visit.id)
            )
          )
      ),
      '[]'::jsonb
    ),
    'fieldIncidents',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', incident.id,
            'visitId', incident.visit_id,
            'jobId', incident.job_id,
            'incidentNumber', incident.incident_number,
            'severity', incident.severity,
            'status', incident.status,
            'category', incident.category,
            'reportedAt', incident.reported_at,
            'summary', incident.summary,
            'version', incident.version
          )
          order by incident.reported_at desc
        )
        from public.incidents incident
        where incident.company_id = p_company_id
          and (
            actor_role in ('owner', 'dispatcher')
            or (
              incident.visit_id is not null
              and public.is_assigned_technician_for_visit(incident.visit_id)
            )
          )
      ),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.get_storyops_field_reference(uuid) from public, anon;
grant execute on function public.get_storyops_field_reference(uuid) to authenticated;

comment on function public.get_storyops_field_reference(uuid) is
  'Role-scoped field reference metadata for active materials, linked SDS documents, assigned checklist definitions, and incidents. Metadata may be cached in the scoped offline workspace; storage contents are not returned.';
