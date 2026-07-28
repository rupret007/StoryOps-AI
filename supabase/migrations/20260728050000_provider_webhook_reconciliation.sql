-- Trusted provider reconciliation. The service role receives EXECUTE only;
-- tenant tables remain inaccessible to direct service-role DML.
-- Use JSON row access because this trigger is shared by tables with different
-- physical columns; PL/pgSQL otherwise resolves an unreachable OLD field.
create or replace function public.enforce_portal_update_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  old_data jsonb := to_jsonb(old);
  new_data jsonb := to_jsonb(new);
  company_id_value uuid := (to_jsonb(old) ->> 'company_id')::uuid;
begin
  if tg_table_name = 'customers'
    and public.is_customer_user(company_id_value, (old_data ->> 'id')::uuid)
    and not public.has_company_role(
      company_id_value,
      array['owner', 'dispatcher']::public.app_role[]
    )
  then
    if (new_data - array[
      'display_name', 'given_name', 'family_name', 'email', 'phone', 'billing_address',
      'updated_at', 'version'
    ]) <> (old_data - array[
      'display_name', 'given_name', 'family_name', 'email', 'phone', 'billing_address',
      'updated_at', 'version'
    ]) then
      raise exception 'Portal users may update contact fields only';
    end if;
  elsif tg_table_name = 'quotes'
    and public.is_customer_user(
      company_id_value,
      (old_data ->> 'customer_id')::uuid
    )
    and not public.has_company_role(
      company_id_value,
      array['owner', 'dispatcher']::public.app_role[]
    )
  then
    if (new_data - array[
      'status', 'accepted_at', 'accepted_by_name', 'accepted_by_user_id',
      'acceptance_ip_hash', 'acceptance_context_hash', 'updated_at', 'version'
    ]) <> (old_data - array[
      'status', 'accepted_at', 'accepted_by_name', 'accepted_by_user_id',
      'acceptance_ip_hash', 'acceptance_context_hash', 'updated_at', 'version'
    ]) then
      raise exception 'Portal users may only view, accept, or decline quotes';
    end if;
  elsif tg_table_name = 'notifications' then
    if (new_data - array['read_at', 'updated_at', 'version'])
      <> (old_data - array['read_at', 'updated_at', 'version']) then
      raise exception 'Notification recipients may update read state only';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.redact_audit_payload(
  source_table text,
  source_data jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public, extensions
as $$
declare
  redacted jsonb := source_data;
  sensitive_fields text[] := case source_table
    when 'customers' then array[
      'email', 'phone', 'billing_address', 'notes', 'tax_exemption_reference'
    ]
    when 'properties' then array[
      'service_address', 'access_instructions', 'gate_code_ciphertext',
      'water_source_notes', 'drainage_notes'
    ]
    when 'consent_records' then array['proof']
    when 'communication_messages' then array['sender', 'recipients', 'body']
    when 'integration_connections' then array[
      'configuration', 'secret_reference', 'last_error'
    ]
    when 'approval_requests' then array['action_payload']
    when 'incidents' then array['summary', 'immediate_actions']
    when 'provider_customers' then array['email_snapshot']
    else array[]::text[]
  end;
  field_name text;
  removed_fields text[] := array[]::text[];
begin
  if source_data is null then
    return null;
  end if;
  foreach field_name in array sensitive_fields
  loop
    if redacted ? field_name then
      redacted := redacted - field_name;
      removed_fields := array_append(removed_fields, field_name);
    end if;
  end loop;
  if cardinality(removed_fields) > 0 then
    redacted := redacted || jsonb_build_object(
      '_redacted_fields',
      to_jsonb(removed_fields),
      '_source_sha256',
      encode(extensions.digest(source_data::text, 'sha256'), 'hex')
    );
  end if;
  return redacted;
end;
$$;

create or replace function public.authorize_outbound_contact(
  p_company_id uuid,
  p_channel text,
  p_purpose text,
  p_contact_fingerprint text,
  p_consent_snapshot_id uuid
)
returns table(
  allowed boolean,
  decision_code text,
  consent_record_id uuid,
  latest_consent_record_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  snapshot_row public.consent_records%rowtype;
  latest_row public.consent_records%rowtype;
  customer_row public.customers%rowtype;
  lead_row public.leads%rowtype;
  stored_contact_value text;
  normalized_contact_value text;
  contact_digits text;
begin
  if p_company_id is null
    or p_channel is null
    or p_channel not in ('sms', 'email', 'voice')
    or p_purpose is null
    or p_purpose not in ('transactional', 'marketing')
    or p_contact_fingerprint is null
    or p_contact_fingerprint !~ '^[a-f0-9]{64}$'
    or p_consent_snapshot_id is null
  then
    raise exception 'Invalid outbound authorization envelope';
  end if;

  select consent.*
  into snapshot_row
  from public.consent_records consent
  where consent.id = p_consent_snapshot_id
    and consent.company_id = p_company_id;

  if not found then
    allowed := false;
    decision_code := 'CONSENT_NOT_GRANTED';
    consent_record_id := null;
    latest_consent_record_id := null;
    return next;
    return;
  end if;

  consent_record_id := snapshot_row.id;
  if snapshot_row.channel <> p_channel
    or snapshot_row.purpose <> p_purpose
    or snapshot_row.status <> 'granted'
  then
    allowed := false;
    decision_code := 'CONSENT_NOT_GRANTED';
    latest_consent_record_id := null;
    return next;
    return;
  end if;

  select consent.*
  into latest_row
  from public.consent_records consent
  where consent.company_id = p_company_id
    and consent.channel = p_channel
    and consent.purpose = p_purpose
    and (
      (
        snapshot_row.customer_id is not null
        and consent.customer_id = snapshot_row.customer_id
      )
      or (
        snapshot_row.lead_id is not null
        and consent.lead_id = snapshot_row.lead_id
      )
    )
  order by
    consent.created_at desc,
    consent.captured_at desc,
    case when consent.status = 'granted' then 0 else 1 end desc,
    consent.id desc
  limit 1;

  latest_consent_record_id := latest_row.id;
  if latest_row.id is null
    or latest_row.id is distinct from snapshot_row.id
    or latest_row.status <> 'granted'
  then
    allowed := false;
    decision_code := 'STALE_CONSENT';
    return next;
    return;
  end if;

  if snapshot_row.customer_id is not null then
    select customer.*
    into customer_row
    from public.customers customer
    where customer.id = snapshot_row.customer_id
      and customer.company_id = p_company_id;
    if not found then
      allowed := false;
      decision_code := 'CONTACT_MISMATCH';
      return next;
      return;
    end if;
    if customer_row.do_not_contact then
      allowed := false;
      decision_code := 'OPTED_OUT';
      return next;
      return;
    end if;
    stored_contact_value := case
      when p_channel = 'email' then customer_row.email::text
      else customer_row.phone
    end;
  else
    select lead.*
    into lead_row
    from public.leads lead
    where lead.id = snapshot_row.lead_id
      and lead.company_id = p_company_id;
    if not found then
      allowed := false;
      decision_code := 'CONTACT_MISMATCH';
      return next;
      return;
    end if;
    stored_contact_value := case
      when p_channel = 'email' then lead_row.email::text
      else lead_row.phone
    end;
  end if;

  if p_channel = 'email' then
    normalized_contact_value := nullif(lower(btrim(stored_contact_value)), '');
  else
    contact_digits := regexp_replace(
      coalesce(stored_contact_value, ''),
      '[^0-9]',
      '',
      'g'
    );
    normalized_contact_value := case
      when length(contact_digits) = 10
        then '+1' || contact_digits
      when length(contact_digits) = 11
        and left(contact_digits, 1) = '1'
        then '+' || contact_digits
      when left(btrim(coalesce(stored_contact_value, '')), 1) = '+'
        and length(contact_digits) >= 8
        then '+' || contact_digits
      else null
    end;
  end if;

  if normalized_contact_value is null
    or encode(
      extensions.digest(normalized_contact_value, 'sha256'),
      'hex'
    ) is distinct from p_contact_fingerprint
  then
    allowed := false;
    decision_code := 'CONTACT_MISMATCH';
    return next;
    return;
  end if;

  allowed := true;
  decision_code := 'ALLOWED';
  return next;
end;
$$;

revoke all on function public.authorize_outbound_contact(
  uuid,
  text,
  text,
  text,
  uuid
) from public, anon, authenticated;
grant execute on function public.authorize_outbound_contact(
  uuid,
  text,
  text,
  text,
  uuid
) to service_role;

comment on function public.authorize_outbound_contact(
  uuid,
  text,
  text,
  text,
  uuid
) is
  'Returns a contact-free outbound consent decision from exact company-scoped evidence; callable only by trusted server code.';

create or replace function public.resolve_stripe_billing_identity(
  p_company_id uuid,
  p_customer_id uuid
)
returns table(
  eligible boolean,
  decision_code text,
  customer_id uuid,
  billing_name text,
  billing_email text,
  provider_customer_id text,
  identity_fingerprint text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  company_status_value text;
  customer_row public.customers%rowtype;
  mapping_row public.provider_customers%rowtype;
begin
  if p_company_id is null or p_customer_id is null then
    raise exception 'Invalid Stripe billing identity envelope';
  end if;

  select company.status
  into company_status_value
  from public.companies company
  where company.id = p_company_id;
  if company_status_value is distinct from 'active' then
    eligible := false;
    decision_code := 'COMPANY_INACTIVE';
    return next;
    return;
  end if;

  select customer.*
  into customer_row
  from public.customers customer
  where customer.id = p_customer_id
    and customer.company_id = p_company_id;
  if not found
    or customer_row.lifecycle = 'blocked'
    or customer_row.email is null
    or length(btrim(customer_row.email::text)) not between 3 and 320
    or length(btrim(customer_row.display_name)) not between 1 and 160
  then
    eligible := false;
    decision_code := 'CUSTOMER_NOT_BILLABLE';
    return next;
    return;
  end if;

  select mapping.*
  into mapping_row
  from public.provider_customers mapping
  where mapping.company_id = p_company_id
    and mapping.customer_id = p_customer_id
    and mapping.provider = 'stripe';
  if found and mapping_row.provider_customer_id !~ '^cus_[A-Za-z0-9]+$' then
    eligible := false;
    decision_code := 'INVALID_MAPPING';
    customer_id := customer_row.id;
    return next;
    return;
  end if;

  eligible := true;
  decision_code := 'ELIGIBLE';
  customer_id := customer_row.id;
  billing_name := btrim(customer_row.display_name);
  billing_email := lower(btrim(customer_row.email::text));
  provider_customer_id := mapping_row.provider_customer_id;
  identity_fingerprint := encode(
    extensions.digest(
      jsonb_build_object(
        'companyId', p_company_id::text,
        'customerId', customer_row.id::text,
        'billingName', billing_name,
        'billingEmail', billing_email
      )::text,
      'sha256'
    ),
    'hex'
  );
  return next;
end;
$$;

create or replace function public.save_stripe_customer_mapping(
  p_company_id uuid,
  p_customer_id uuid,
  p_provider_customer_id text,
  p_identity_fingerprint text
)
returns table(
  saved boolean,
  decision_code text,
  mapping_id uuid,
  provider_customer_id text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  company_status_value text;
  customer_row public.customers%rowtype;
  mapping_row public.provider_customers%rowtype;
  billing_name_value text;
  billing_email_value text;
  expected_fingerprint text;
begin
  if p_company_id is null
    or p_customer_id is null
    or p_provider_customer_id is null
    or p_provider_customer_id !~ '^cus_[A-Za-z0-9]+$'
    or length(p_provider_customer_id) > 255
    or p_identity_fingerprint is null
    or p_identity_fingerprint !~ '^[a-f0-9]{64}$'
  then
    raise exception 'Invalid Stripe customer mapping envelope';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer:' || p_provider_customer_id, 0)
  );

  select company.status
  into company_status_value
  from public.companies company
  where company.id = p_company_id;
  if company_status_value is distinct from 'active' then
    saved := false;
    decision_code := 'COMPANY_INACTIVE';
    return next;
    return;
  end if;

  select customer.*
  into customer_row
  from public.customers customer
  where customer.id = p_customer_id
    and customer.company_id = p_company_id
  for share;
  if not found
    or customer_row.lifecycle = 'blocked'
    or customer_row.email is null
    or length(btrim(customer_row.email::text)) not between 3 and 320
    or length(btrim(customer_row.display_name)) not between 1 and 160
  then
    saved := false;
    decision_code := 'CUSTOMER_NOT_BILLABLE';
    return next;
    return;
  end if;

  billing_name_value := btrim(customer_row.display_name);
  billing_email_value := lower(btrim(customer_row.email::text));
  expected_fingerprint := encode(
    extensions.digest(
      jsonb_build_object(
        'companyId', p_company_id::text,
        'customerId', customer_row.id::text,
        'billingName', billing_name_value,
        'billingEmail', billing_email_value
      )::text,
      'sha256'
    ),
    'hex'
  );
  if expected_fingerprint is distinct from p_identity_fingerprint then
    saved := false;
    decision_code := 'IDENTITY_STALE';
    return next;
    return;
  end if;

  if exists (
    select 1
    from public.provider_customers mapping
    where mapping.provider = 'stripe'
      and mapping.provider_customer_id = p_provider_customer_id
      and (
        mapping.company_id <> p_company_id
        or mapping.customer_id <> p_customer_id
      )
  ) then
    saved := false;
    decision_code := 'MAPPING_CONFLICT';
    return next;
    return;
  end if;

  select mapping.*
  into mapping_row
  from public.provider_customers mapping
  where mapping.company_id = p_company_id
    and mapping.customer_id = p_customer_id
    and mapping.provider = 'stripe'
  for update;
  if found then
    if mapping_row.provider_customer_id <> p_provider_customer_id then
      saved := false;
      decision_code := 'MAPPING_CONFLICT';
      mapping_id := mapping_row.id;
      provider_customer_id := mapping_row.provider_customer_id;
      return next;
      return;
    end if;
    if mapping_row.email_snapshot is distinct from billing_email_value then
      update public.provider_customers
      set email_snapshot = billing_email_value, updated_at = now()
      where id = mapping_row.id
        and company_id = p_company_id;
    end if;
    saved := true;
    decision_code := 'SAVED';
    mapping_id := mapping_row.id;
    provider_customer_id := mapping_row.provider_customer_id;
    return next;
    return;
  end if;

  mapping_id := null;
  insert into public.provider_customers(
    company_id,
    customer_id,
    provider,
    provider_customer_id,
    email_snapshot
  )
  values (
    p_company_id,
    p_customer_id,
    'stripe',
    p_provider_customer_id,
    billing_email_value
  )
  on conflict do nothing
  returning id into mapping_id;

  if mapping_id is null then
    select mapping.*
    into mapping_row
    from public.provider_customers mapping
    where mapping.company_id = p_company_id
      and mapping.customer_id = p_customer_id
      and mapping.provider = 'stripe';
    if not found
      or mapping_row.provider_customer_id <> p_provider_customer_id
    then
      saved := false;
      decision_code := 'MAPPING_CONFLICT';
      mapping_id := mapping_row.id;
      provider_customer_id := mapping_row.provider_customer_id;
      return next;
      return;
    end if;
    mapping_id := mapping_row.id;
  end if;

  saved := true;
  decision_code := 'SAVED';
  provider_customer_id := p_provider_customer_id;
  return next;
end;
$$;

revoke all on table public.provider_customers from service_role;
revoke all on function public.resolve_stripe_billing_identity(
  uuid,
  uuid
) from public, anon, authenticated;
revoke all on function public.save_stripe_customer_mapping(
  uuid,
  uuid,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.resolve_stripe_billing_identity(
  uuid,
  uuid
) to service_role;
grant execute on function public.save_stripe_customer_mapping(
  uuid,
  uuid,
  text,
  text
) to service_role;

comment on function public.resolve_stripe_billing_identity(
  uuid,
  uuid
) is
  'Returns only the exact company customer billing name/email, optional Stripe mapping, and opaque identity fingerprint to trusted server code.';
comment on function public.save_stripe_customer_mapping(
  uuid,
  uuid,
  text,
  text
) is
  'Creates an idempotent Stripe customer mapping only while the exact billing identity fingerprint remains current.';

create or replace function public.reconcile_provider_webhook(
  p_event_id uuid,
  p_payload_hash text,
  p_company_id uuid,
  p_provider text,
  p_reconciliation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  webhook_row public.webhook_events%rowtype;
  invoice_row public.invoices%rowtype;
  payment_row public.payments%rowtype;
  refund_row public.payments%rowtype;
  original_payment_row public.payments%rowtype;
  message_row public.communication_messages%rowtype;
  customer_row public.customers%rowtype;
  lead_row public.leads%rowtype;
  before_snapshot jsonb;
  after_snapshot jsonb;
  target_ids uuid[];
  target_id uuid;
  job_id_value uuid;
  quote_id_value uuid;
  approval_id_value uuid;
  object_id_value text;
  payment_intent_id_value text;
  provider_message_id_value text;
  contact_fingerprint_value text;
  consent_signal_value text;
  event_type_value text;
  object_kind_value text;
  action_value text;
  channel_value text;
  incoming_status text;
  target_status text;
  failure_code_value text;
  currency_value text;
  occurred_at_value timestamptz;
  amount_cents_value bigint;
  amount_paid_cents_value bigint;
  amount_remaining_cents_value bigint;
  total_cents_value bigint;
  original_amount_cents_value bigint;
  refunded_total_cents_value bigint;
  changed_value boolean := false;
  disposition_value text := 'processed';
  entity_type_value text := 'webhook_event';
  entity_id_value uuid := p_event_id;
  provider_id_value text;
  expected_failure_code text;
  unexpected_key text;
  customer_ids uuid[];
  lead_ids uuid[];
  purpose_value text;
  proof_value text;
  affected_count integer;
begin
  if p_event_id is null
    or p_company_id is null
    or p_payload_hash is null
    or p_payload_hash !~ '^[a-f0-9]{64}$'
    or p_provider is null
    or p_provider not in ('stripe', 'twilio', 'email')
    or p_reconciliation is null
    or jsonb_typeof(p_reconciliation) <> 'object'
  then
    raise exception 'Invalid provider reconciliation envelope';
  end if;

  select *
  into webhook_row
  from public.webhook_events
  where id = p_event_id
  for update;

  if not found
    or webhook_row.company_id <> p_company_id
    or webhook_row.provider <> p_provider
    or webhook_row.payload_hash <> p_payload_hash
    or webhook_row.status <> 'processing'
  then
    raise exception 'Provider reconciliation does not own the processing lease';
  end if;

  select key
  into unexpected_key
  from jsonb_object_keys(p_reconciliation) as keys(key)
  where key <> all(array[
    'schemaVersion', 'provider', 'eventId', 'eventType', 'objectId', 'objectKind',
    'action', 'companyId', 'occurredAt', 'quoteId', 'jobId', 'approvalId',
    'paymentIntentId', 'amountCents', 'amountPaidCents', 'amountRemainingCents',
    'currency', 'failureCode', 'providerMessageId', 'channel', 'disposition',
    'deliveryStatus', 'errorCode', 'consentSignal', 'contactFingerprint'
  ]::text[])
  limit 1;
  if unexpected_key is not null then
    raise exception 'Provider reconciliation contains an unsupported field';
  end if;

  if p_reconciliation ->> 'schemaVersion'
      is distinct from 'storyops-provider-receipt-v1'
    or p_reconciliation ->> 'provider' is distinct from p_provider
    or p_reconciliation ->> 'eventId'
      is distinct from webhook_row.provider_event_id
    or p_reconciliation ->> 'eventType'
      is distinct from webhook_row.event_type
    or p_reconciliation ->> 'companyId' is distinct from p_company_id::text
  then
    raise exception 'Provider reconciliation receipt does not match the claimed event';
  end if;

  event_type_value := p_reconciliation ->> 'eventType';
  object_kind_value := p_reconciliation ->> 'objectKind';
  action_value := coalesce(p_reconciliation ->> 'action', 'ignore');
  object_id_value := nullif(p_reconciliation ->> 'objectId', '');
  payment_intent_id_value := nullif(p_reconciliation ->> 'paymentIntentId', '');
  provider_message_id_value := nullif(p_reconciliation ->> 'providerMessageId', '');
  contact_fingerprint_value := nullif(p_reconciliation ->> 'contactFingerprint', '');
  consent_signal_value := coalesce(p_reconciliation ->> 'consentSignal', 'none');
  channel_value := nullif(p_reconciliation ->> 'channel', '');
  incoming_status := nullif(p_reconciliation ->> 'deliveryStatus', '');
  currency_value := lower(nullif(p_reconciliation ->> 'currency', ''));
  failure_code_value := left(
    regexp_replace(
      coalesce(nullif(p_reconciliation ->> 'failureCode', ''), ''),
      '[^a-zA-Z0-9_.:-]',
      '_',
      'g'
    ),
    120
  );

  begin
    occurred_at_value := coalesce(
      nullif(p_reconciliation ->> 'occurredAt', '')::timestamptz,
      webhook_row.received_at
    );
    quote_id_value := nullif(p_reconciliation ->> 'quoteId', '')::uuid;
    job_id_value := nullif(p_reconciliation ->> 'jobId', '')::uuid;
    approval_id_value := nullif(p_reconciliation ->> 'approvalId', '')::uuid;
    amount_cents_value := nullif(p_reconciliation ->> 'amountCents', '')::bigint;
    amount_paid_cents_value := nullif(
      p_reconciliation ->> 'amountPaidCents',
      ''
    )::bigint;
    amount_remaining_cents_value := nullif(
      p_reconciliation ->> 'amountRemainingCents',
      ''
    )::bigint;
  exception
    when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
      raise exception 'Provider reconciliation contains an invalid typed value';
  end;

  if occurred_at_value > now() + interval '5 minutes'
    or occurred_at_value < webhook_row.received_at - interval '3 years'
    or amount_cents_value < 0
    or amount_paid_cents_value < 0
    or amount_remaining_cents_value < 0
    or amount_cents_value > 99999999999999
    or amount_paid_cents_value > 99999999999999
    or amount_remaining_cents_value > 99999999999999
  then
    raise exception 'Provider reconciliation contains an out-of-policy value';
  end if;

  if p_provider = 'stripe' then
    if (
      action_value <> 'ignore'
      and (currency_value is null or currency_value <> 'usd')
    )
      or object_id_value is null
      or object_kind_value is null
      or object_kind_value not in (
        'checkout', 'payment_intent', 'invoice', 'refund', 'unsupported'
      )
      or length(object_id_value) > 255
      or action_value not in (
        'payment_pending', 'payment_succeeded', 'payment_failed',
        'invoice_open', 'invoice_paid', 'invoice_void', 'invoice_uncollectible',
        'refund_pending', 'refund_succeeded', 'refund_failed', 'ignore'
      )
    then
      raise exception 'Invalid Stripe reconciliation action';
    end if;
    if (
      event_type_value like 'checkout.session.%'
      and (object_kind_value <> 'checkout' or object_id_value !~ '^cs_')
    ) or (
      event_type_value like 'payment_intent.%'
      and (object_kind_value <> 'payment_intent' or object_id_value !~ '^pi_')
    ) or (
      event_type_value like 'invoice.%'
      and (object_kind_value <> 'invoice' or object_id_value !~ '^in_')
    ) or (
      event_type_value like 'refund.%'
      and (object_kind_value <> 'refund' or object_id_value !~ '^re_')
    ) or (
      event_type_value not like 'checkout.session.%'
      and event_type_value not like 'payment_intent.%'
      and event_type_value not like 'invoice.%'
      and event_type_value not like 'refund.%'
      and object_kind_value <> 'unsupported'
    ) or (
      payment_intent_id_value is not null
      and payment_intent_id_value !~ '^pi_'
    )
    then
      raise exception 'Stripe object kind or provider ID prefix is invalid';
    end if;

    if not (
      (
        event_type_value in (
          'checkout.session.completed',
          'checkout.session.async_payment_succeeded'
        )
        and action_value in ('payment_pending', 'payment_succeeded')
      )
      or (
        event_type_value in (
          'checkout.session.async_payment_failed',
          'checkout.session.expired'
        )
        and action_value = 'payment_failed'
      )
      or (
        event_type_value = 'payment_intent.processing'
        and action_value = 'payment_pending'
      )
      or (
        event_type_value = 'payment_intent.succeeded'
        and action_value = 'payment_succeeded'
      )
      or (
        event_type_value in (
          'payment_intent.payment_failed',
          'payment_intent.canceled'
        )
        and action_value = 'payment_failed'
      )
      or (
        event_type_value in (
          'invoice.finalized',
          'invoice.sent',
          'invoice.payment_failed'
        )
        and action_value = 'invoice_open'
      )
      or (
        event_type_value in ('invoice.paid', 'invoice.payment_succeeded')
        and action_value = 'invoice_paid'
      )
      or (
        event_type_value = 'invoice.voided'
        and action_value = 'invoice_void'
      )
      or (
        event_type_value = 'invoice.marked_uncollectible'
        and action_value = 'invoice_uncollectible'
      )
      or (
        event_type_value in ('refund.created', 'refund.updated')
        and action_value in (
          'refund_pending',
          'refund_succeeded',
          'refund_failed'
        )
      )
      or (
        event_type_value = 'refund.failed'
        and action_value = 'refund_failed'
      )
      or (
        action_value = 'ignore'
        and event_type_value not in (
          'checkout.session.completed',
          'checkout.session.async_payment_succeeded',
          'checkout.session.async_payment_failed',
          'checkout.session.expired',
          'payment_intent.processing',
          'payment_intent.succeeded',
          'payment_intent.payment_failed',
          'payment_intent.canceled',
          'invoice.finalized',
          'invoice.sent',
          'invoice.payment_failed',
          'invoice.paid',
          'invoice.payment_succeeded',
          'invoice.voided',
          'invoice.marked_uncollectible',
          'refund.created',
          'refund.updated',
          'refund.failed'
        )
      )
    ) then
      raise exception 'Stripe event type and reconciliation action do not match';
    end if;

    if action_value = 'ignore' then
      disposition_value := 'ignored';
    elsif action_value like 'invoice_%' then
      if job_id_value is null or amount_cents_value is null then
        raise exception 'Stripe invoice reconciliation requires job and amount';
      end if;

      select array_agg(id order by id)
      into target_ids
      from public.invoices
      where company_id = p_company_id
        and provider_invoice_id = object_id_value;

      if coalesce(cardinality(target_ids), 0) = 0 then
        select array_agg(id order by id)
        into target_ids
        from public.invoices
        where company_id = p_company_id
          and job_id = job_id_value;
      end if;
      if coalesce(cardinality(target_ids), 0) <> 1 then
        raise exception 'Stripe invoice did not resolve to exactly one local invoice';
      end if;

      select *
      into invoice_row
      from public.invoices
      where id = target_ids[1]
      for update;

      if invoice_row.job_id is distinct from job_id_value
        or (
          invoice_row.provider_invoice_id is not null
          and invoice_row.provider_invoice_id <> object_id_value
        )
      then
        raise exception 'Stripe invoice metadata conflicts with the local invoice';
      end if;

      total_cents_value := round(invoice_row.total * 100)::bigint;
      if total_cents_value <> amount_cents_value then
        raise exception 'Stripe invoice total does not match the local invoice';
      end if;

      target_status := invoice_row.status;
      if action_value = 'invoice_open'
        and invoice_row.status in ('draft', 'open')
      then
        target_status := 'open';
      elsif action_value = 'invoice_paid' then
        if invoice_row.status in ('void', 'uncollectible') then
          raise exception 'Stripe paid event conflicts with a terminal local invoice';
        end if;
        if amount_paid_cents_value is null
          or amount_remaining_cents_value is null
          or amount_paid_cents_value <> total_cents_value
          or amount_remaining_cents_value <> 0
        then
          raise exception 'Stripe paid event does not prove the local invoice balance';
        end if;
        target_status := 'paid';
      elsif action_value = 'invoice_void'
        and invoice_row.status <> 'paid'
      then
        target_status := 'void';
      elsif action_value = 'invoice_uncollectible'
        and invoice_row.status <> 'paid'
      then
        target_status := 'uncollectible';
      end if;

      before_snapshot := jsonb_build_object(
        'status', invoice_row.status,
        'providerInvoiceId', invoice_row.provider_invoice_id,
        'amountPaid', invoice_row.amount_paid,
        'balanceDue', invoice_row.balance_due,
        'version', invoice_row.version
      );

      if invoice_row.provider_invoice_id is distinct from object_id_value
        or invoice_row.status is distinct from target_status
        or (
          target_status = 'paid'
          and (
            round(invoice_row.amount_paid * 100)::bigint <> total_cents_value
            or round(invoice_row.balance_due * 100)::bigint <> 0
          )
        )
        or (
          event_type_value = 'invoice.sent'
          and invoice_row.sent_at is null
        )
      then
        update public.invoices
        set
          provider_invoice_id = object_id_value,
          status = target_status,
          amount_paid = case
            when target_status = 'paid' then invoice_row.total
            else invoice_row.amount_paid
          end,
          balance_due = case
            when target_status = 'paid' then 0
            else invoice_row.balance_due
          end,
          paid_at = case
            when target_status = 'paid' then coalesce(invoice_row.paid_at, occurred_at_value)
            else invoice_row.paid_at
          end,
          sent_at = case
            when event_type_value = 'invoice.sent'
              then coalesce(invoice_row.sent_at, occurred_at_value)
            else invoice_row.sent_at
          end,
          updated_at = now(),
          version = invoice_row.version + 1
        where id = invoice_row.id
          and company_id = p_company_id;
        changed_value := true;
        select * into invoice_row from public.invoices where id = invoice_row.id;
      end if;

      entity_type_value := 'invoice';
      entity_id_value := invoice_row.id;
      after_snapshot := jsonb_build_object(
        'status', invoice_row.status,
        'providerInvoiceId', invoice_row.provider_invoice_id,
        'amountPaid', invoice_row.amount_paid,
        'balanceDue', invoice_row.balance_due,
        'version', invoice_row.version
      );
    elsif action_value like 'refund_%' then
      if approval_id_value is null or amount_cents_value is null then
        raise exception 'Stripe refund reconciliation requires approval and amount';
      end if;

      perform 1
      from public.approval_requests
      where id = approval_id_value
        and company_id = p_company_id
        and reason = 'refund'
        and status = 'approved'
        and action_type = 'payments.refund';
      if not found then
        raise exception 'Stripe refund is not backed by an approved local request';
      end if;

      select array_agg(id order by id)
      into target_ids
      from public.payments
      where company_id = p_company_id
        and provider = 'stripe'
        and payment_type = 'refund'
        and approval_request_id = approval_id_value;
      if coalesce(cardinality(target_ids), 0) <> 1 then
        raise exception 'Stripe refund did not resolve to exactly one approved payment';
      end if;

      select *
      into refund_row
      from public.payments
      where id = target_ids[1]
      for update;
      if round(refund_row.amount * 100)::bigint <> amount_cents_value
        or (
          refund_row.provider_payment_id is not null
          and refund_row.provider_payment_id <> object_id_value
        )
      then
        raise exception 'Stripe refund conflicts with the approved local amount or ID';
      end if;

      before_snapshot := jsonb_build_object(
        'status', refund_row.status,
        'providerPaymentId', refund_row.provider_payment_id,
        'amount', refund_row.amount,
        'version', refund_row.version
      );
      target_status := case action_value
        when 'refund_succeeded' then 'succeeded'
        when 'refund_failed' then
          case when refund_row.status = 'succeeded' then 'succeeded' else 'failed' end
        else
          case when refund_row.status in ('succeeded', 'failed')
            then refund_row.status
            else 'pending'
          end
      end;
      expected_failure_code := case
        when target_status = 'failed'
          then coalesce(nullif(failure_code_value, ''), 'provider_refund_failed')
        else null
      end;

      if refund_row.provider_payment_id is distinct from object_id_value
        or refund_row.status is distinct from target_status
        or refund_row.failure_code is distinct from expected_failure_code
      then
        update public.payments
        set
          provider_payment_id = object_id_value,
          status = target_status,
          processed_at = case
            when target_status = 'succeeded'
              then coalesce(refund_row.processed_at, occurred_at_value)
            else null
          end,
          failure_code = expected_failure_code,
          updated_at = now(),
          version = refund_row.version + 1
        where id = refund_row.id
          and company_id = p_company_id;
        changed_value := true;
        select * into refund_row from public.payments where id = refund_row.id;
      end if;

      if action_value = 'refund_succeeded' then
        if payment_intent_id_value is null then
          raise exception 'Stripe refund omitted its original payment intent';
        end if;
        select array_agg(id order by id)
        into target_ids
        from public.payments
        where company_id = p_company_id
          and provider = 'stripe'
          and payment_type <> 'refund'
          and provider_payment_id = payment_intent_id_value;
        if coalesce(cardinality(target_ids), 0) = 0 then
          select array_agg(id order by id)
          into target_ids
          from public.payments
          where company_id = p_company_id
            and provider = 'stripe'
            and payment_type <> 'refund'
            and invoice_id = refund_row.invoice_id
            and status in ('succeeded', 'partially_refunded');
        end if;
        if coalesce(cardinality(target_ids), 0) <> 1 then
          raise exception 'Stripe refund did not resolve to one original payment';
        end if;

        select *
        into original_payment_row
        from public.payments
        where id = target_ids[1]
        for update;
        if original_payment_row.invoice_id <> refund_row.invoice_id then
          raise exception 'Stripe refund original payment is outside the approved invoice';
        end if;
        select count(*)
        into affected_count
        from public.payments
        where company_id = p_company_id
          and provider = 'stripe'
          and payment_type <> 'refund'
          and invoice_id = refund_row.invoice_id;
        if affected_count <> 1 then
          raise exception 'Stripe refund is ambiguous across multiple invoice payments';
        end if;
        original_amount_cents_value := round(original_payment_row.amount * 100)::bigint;
        select coalesce(round(sum(amount) * 100)::bigint, 0)
        into refunded_total_cents_value
        from public.payments
        where company_id = p_company_id
          and provider = 'stripe'
          and payment_type = 'refund'
          and invoice_id = refund_row.invoice_id
          and status = 'succeeded';
        if refunded_total_cents_value > original_amount_cents_value then
          raise exception 'Stripe refunds exceed the original local payment';
        end if;
        target_status := case
          when refunded_total_cents_value = original_amount_cents_value then 'refunded'
          else 'partially_refunded'
        end;
        if original_payment_row.status is distinct from target_status then
          update public.payments
          set
            status = target_status,
            failure_code = null,
            updated_at = now(),
            version = original_payment_row.version + 1
          where id = original_payment_row.id
            and company_id = p_company_id;
          changed_value := true;
        end if;
      end if;

      entity_type_value := 'payment';
      entity_id_value := refund_row.id;
      after_snapshot := jsonb_build_object(
        'status', refund_row.status,
        'providerPaymentId', refund_row.provider_payment_id,
        'amount', refund_row.amount,
        'approvalId', refund_row.approval_request_id,
        'version', refund_row.version,
        'originalPaymentId', case
          when original_payment_row.id is not null then original_payment_row.id
          else null
        end,
        'originalPaymentStatus', case
          when original_payment_row.id is not null then target_status
          else null
        end
      );
    else
      if quote_id_value is null or amount_cents_value is null then
        raise exception 'Stripe payment reconciliation requires quote and amount';
      end if;

      select array_agg(id order by id)
      into target_ids
      from public.payments
      where company_id = p_company_id
        and provider = 'stripe'
        and payment_type <> 'refund'
        and provider_payment_id in (
          object_id_value,
          coalesce(payment_intent_id_value, object_id_value)
        );

      if coalesce(cardinality(target_ids), 0) = 0 then
        select array_agg(id order by id)
        into target_ids
        from public.jobs
        where company_id = p_company_id
          and quote_id = quote_id_value;
        if coalesce(cardinality(target_ids), 0) <> 1 then
          raise exception 'Stripe quote did not resolve to exactly one local job';
        end if;
        target_id := target_ids[1];

        select array_agg(id order by id)
        into target_ids
        from public.invoices
        where company_id = p_company_id
          and job_id = target_id;
        if coalesce(cardinality(target_ids), 0) <> 1 then
          raise exception 'Stripe quote did not resolve to exactly one local invoice';
        end if;
        target_id := target_ids[1];

        select array_agg(id order by id)
        into target_ids
        from public.payments
        where company_id = p_company_id
          and provider = 'stripe'
          and payment_type <> 'refund'
          and invoice_id = target_id;
      end if;
      if coalesce(cardinality(target_ids), 0) <> 1 then
        raise exception 'Stripe event did not resolve to exactly one local payment';
      end if;

      select *
      into payment_row
      from public.payments
      where id = target_ids[1]
      for update;
      perform 1
      from public.invoices invoice
      join public.jobs job on job.id = invoice.job_id
      where invoice.id = payment_row.invoice_id
        and invoice.company_id = p_company_id
        and job.company_id = p_company_id
        and job.quote_id = quote_id_value;
      if not found then
        raise exception 'Stripe payment does not belong to the metadata quote';
      end if;
      if round(payment_row.amount * 100)::bigint <> amount_cents_value then
        raise exception 'Stripe amount does not match the deterministic local payment';
      end if;

      provider_id_value := case
        when object_kind_value = 'checkout'
          then coalesce(payment_intent_id_value, object_id_value)
        else object_id_value
      end;
      if payment_row.provider_payment_id is not null
        and payment_row.provider_payment_id <> provider_id_value
      then
        raise exception 'Stripe provider ID conflicts with the local payment';
      end if;
      provider_id_value := coalesce(
        payment_row.provider_payment_id,
        provider_id_value
      );
      target_status := case action_value
        when 'payment_succeeded' then 'succeeded'
        when 'payment_failed' then
          case
            when payment_row.status in ('succeeded', 'refunded', 'partially_refunded')
              then payment_row.status
            else 'failed'
          end
        else
          case
            when payment_row.status in ('succeeded', 'failed', 'refunded', 'partially_refunded')
              then payment_row.status
            else 'pending'
          end
      end;
      if payment_row.status in ('refunded', 'partially_refunded') then
        target_status := payment_row.status;
      end if;
      expected_failure_code := case
        when target_status = 'failed'
          then coalesce(nullif(failure_code_value, ''), 'provider_payment_failed')
        else null
      end;

      before_snapshot := jsonb_build_object(
        'status', payment_row.status,
        'providerPaymentId', payment_row.provider_payment_id,
        'amount', payment_row.amount,
        'version', payment_row.version
      );
      if payment_row.provider_payment_id is null
        or payment_row.status is distinct from target_status
        or payment_row.failure_code is distinct from expected_failure_code
      then
        update public.payments
        set
          provider_payment_id = provider_id_value,
          status = target_status,
          processed_at = case
            when target_status in ('succeeded', 'refunded', 'partially_refunded')
              then coalesce(payment_row.processed_at, occurred_at_value)
            else null
          end,
          failure_code = expected_failure_code,
          updated_at = now(),
          version = payment_row.version + 1
        where id = payment_row.id
          and company_id = p_company_id;
        changed_value := true;
        select * into payment_row from public.payments where id = payment_row.id;
      end if;

      entity_type_value := 'payment';
      entity_id_value := payment_row.id;
      after_snapshot := jsonb_build_object(
        'status', payment_row.status,
        'providerPaymentId', payment_row.provider_payment_id,
        'amount', payment_row.amount,
        'version', payment_row.version
      );
    end if;
  else
    if consent_signal_value not in ('none', 'opt_out', 'opt_in') then
      raise exception 'Invalid provider consent signal';
    end if;

    if p_provider = 'twilio'
      and consent_signal_value in ('opt_out', 'opt_in')
    then
      if event_type_value <> 'inbound_message'
        or channel_value <> 'sms'
        or incoming_status is not null
        or provider_message_id_value !~ '^SM'
        or contact_fingerprint_value !~ '^[a-f0-9]{64}$'
      then
        raise exception 'Invalid inbound Twilio consent event';
      end if;

      select array_agg(customer.id order by customer.id)
      into customer_ids
      from public.customers customer
      cross join lateral (
        select regexp_replace(customer.phone, '[^0-9]', '', 'g') as digits
      ) normalized
      where customer.company_id = p_company_id
        and customer.phone is not null
        and encode(
          extensions.digest(
            case
              when length(normalized.digits) = 10
                then '+1' || normalized.digits
              when length(normalized.digits) = 11
                and left(normalized.digits, 1) = '1'
                then '+' || normalized.digits
              when left(btrim(customer.phone), 1) = '+'
                and length(normalized.digits) >= 8
                then '+' || normalized.digits
              else null
            end,
            'sha256'
          ),
          'hex'
        ) = contact_fingerprint_value;

      select array_agg(lead.id order by lead.id)
      into lead_ids
      from public.leads lead
      cross join lateral (
        select regexp_replace(lead.phone, '[^0-9]', '', 'g') as digits
      ) normalized
      where lead.company_id = p_company_id
        and lead.phone is not null
        and encode(
          extensions.digest(
            case
              when length(normalized.digits) = 10
                then '+1' || normalized.digits
              when length(normalized.digits) = 11
                and left(normalized.digits, 1) = '1'
                then '+' || normalized.digits
              when left(btrim(lead.phone), 1) = '+'
                and length(normalized.digits) >= 8
                then '+' || normalized.digits
              else null
            end,
            'sha256'
          ),
          'hex'
        ) = contact_fingerprint_value;

      if coalesce(cardinality(customer_ids), 0)
        + coalesce(cardinality(lead_ids), 0) <> 1
      then
        raise exception 'Inbound consent did not resolve to exactly one company subject';
      end if;

      if coalesce(cardinality(customer_ids), 0) = 1 then
        select *
        into customer_row
        from public.customers
        where id = customer_ids[1]
        for update;
        entity_type_value := 'customer';
        entity_id_value := customer_row.id;
        before_snapshot := jsonb_build_object(
          'doNotContact', customer_row.do_not_contact,
          'version', customer_row.version
        );
        if consent_signal_value = 'opt_out'
          and not customer_row.do_not_contact
        then
          update public.customers
          set
            do_not_contact = true,
            updated_at = now(),
            version = customer_row.version + 1
          where id = customer_row.id
            and company_id = p_company_id;
          changed_value := true;
          select *
          into customer_row
          from public.customers
          where id = customer_row.id;
        end if;
      else
        select *
        into lead_row
        from public.leads
        where id = lead_ids[1]
        for update;
        entity_type_value := 'lead';
        entity_id_value := lead_row.id;
        before_snapshot := jsonb_build_object(
          'lifecycle', lead_row.status,
          'version', lead_row.version
        );
      end if;

      proof_value :=
        'provider=twilio;event=' || webhook_row.provider_event_id ||
        ';contact_sha256=' || contact_fingerprint_value;
      foreach purpose_value in array array['transactional', 'marketing']::text[]
      loop
        insert into public.consent_records(
          company_id,
          customer_id,
          lead_id,
          channel,
          purpose,
          status,
          captured_at,
          capture_method,
          disclosure_version,
          proof,
          withdrawn_at
        )
        select
          p_company_id,
          case when customer_row.id is not null then customer_row.id else null end,
          case when lead_row.id is not null then lead_row.id else null end,
          'sms',
          purpose_value,
          case
            when consent_signal_value = 'opt_out' then 'withdrawn'
            else 'unknown'
          end,
          occurred_at_value,
          'keyword',
          case
            when consent_signal_value = 'opt_out' then 'sms-keyword-v1'
            else 'sms-keyword-review-v1'
          end,
          proof_value,
          case
            when consent_signal_value = 'opt_out' then occurred_at_value
            else null
          end
        where not exists (
          select 1
          from public.consent_records consent
          where consent.company_id = p_company_id
            and consent.customer_id is not distinct from customer_row.id
            and consent.lead_id is not distinct from lead_row.id
            and consent.channel = 'sms'
            and consent.purpose = purpose_value
            and consent.proof = proof_value
        );
        get diagnostics affected_count = row_count;
        if affected_count > 0 then
          changed_value := true;
        end if;
      end loop;

      after_snapshot := jsonb_build_object(
        'consentSignal', consent_signal_value,
        'smsTransactional', case
          when consent_signal_value = 'opt_out' then 'withdrawn'
          else 'unknown_review_required'
        end,
        'smsMarketing', case
          when consent_signal_value = 'opt_out' then 'withdrawn'
          else 'unknown_review_required'
        end,
        'doNotContact', case
          when customer_row.id is not null then customer_row.do_not_contact
          else null
        end
      );
    else
      if provider_message_id_value is null
        or length(provider_message_id_value) > 255
        or channel_value not in ('sms', 'voice', 'email')
        or (
          p_provider = 'twilio'
          and channel_value not in ('sms', 'voice')
        )
        or (
          p_provider = 'email'
          and channel_value <> 'email'
        )
        or (
          p_provider = 'twilio'
          and channel_value = 'sms'
          and provider_message_id_value !~ '^SM'
        )
        or (
          p_provider = 'twilio'
          and channel_value = 'voice'
          and provider_message_id_value !~ '^CA'
        )
      then
        raise exception 'Invalid delivery reconciliation target';
      end if;

      if incoming_status is null then
        disposition_value := 'ignored';
      elsif incoming_status not in ('queued', 'sent', 'delivered', 'failed') then
        raise exception 'Invalid provider delivery status';
      else
        if p_provider = 'twilio' and not (
          (
            lower(event_type_value) in (
              'accepted', 'scheduled', 'queued', 'sending', 'receiving',
              'initiated', 'ringing'
            )
            and incoming_status = 'queued'
          )
          or (
            lower(event_type_value) in ('sent', 'in-progress')
            and incoming_status = 'sent'
          )
          or (
            lower(event_type_value) in ('delivered', 'completed')
            and incoming_status = 'delivered'
          )
          or (
            lower(event_type_value) in (
              'failed', 'undelivered', 'canceled', 'busy', 'no-answer'
            )
            and incoming_status = 'failed'
          )
        ) then
          raise exception 'Twilio event type and delivery status do not match';
        end if;

        select array_agg(id order by id)
        into target_ids
        from public.communication_messages
        where company_id = p_company_id
          and channel = channel_value
          and direction = 'outbound'
          and provider_message_id = provider_message_id_value;
        if coalesce(cardinality(target_ids), 0) <> 1 then
          raise exception 'Provider delivery did not resolve to one outbound message';
        end if;

        select *
        into message_row
        from public.communication_messages
        where id = target_ids[1]
        for update;
        target_status := case
          when message_row.delivery_status in ('received', 'delivered')
            then message_row.delivery_status
          when incoming_status = 'delivered'
            then 'delivered'
          when message_row.delivery_status = 'failed'
            then 'failed'
          when incoming_status = 'failed'
            then 'failed'
          when message_row.delivery_status = 'sent'
            then 'sent'
          else incoming_status
        end;
        before_snapshot := jsonb_build_object(
          'deliveryStatus', message_row.delivery_status,
          'providerMessageId', message_row.provider_message_id,
          'version', message_row.version
        );
        if target_status is distinct from message_row.delivery_status then
          update public.communication_messages
          set
            delivery_status = target_status,
            updated_at = now(),
            version = message_row.version + 1
          where id = message_row.id
            and company_id = p_company_id;
          changed_value := true;
          select *
          into message_row
          from public.communication_messages
          where id = message_row.id;
        end if;
        entity_type_value := 'communication_message';
        entity_id_value := message_row.id;
        after_snapshot := jsonb_build_object(
          'deliveryStatus', message_row.delivery_status,
          'providerMessageId', message_row.provider_message_id,
          'version', message_row.version
        );
      end if;
    end if;
  end if;

  if before_snapshot is null then
    before_snapshot := jsonb_build_object(
      'providerEventId', webhook_row.provider_event_id,
      'eventType', webhook_row.event_type
    );
  end if;
  if after_snapshot is null then
    after_snapshot := jsonb_build_object(
      'providerEventId', webhook_row.provider_event_id,
      'eventType', webhook_row.event_type,
      'disposition', disposition_value
    );
  end if;

  if not exists (
    select 1
    from public.audit_events
    where company_id = p_company_id
      and request_id = p_event_id::text
      and actor_type = 'provider'
      and actor_id = p_provider
      and action = 'provider_webhook_reconciled'
  ) then
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
      now(),
      'provider',
      p_provider,
      'provider_webhook_reconciled',
      entity_type_value,
      entity_id_value,
      before_snapshot,
      after_snapshot,
      p_event_id::text,
      'audit',
      now() + interval '7 years'
    );
  end if;

  return jsonb_build_object(
    'disposition', disposition_value,
    'changed', changed_value,
    'entityType', entity_type_value,
    'entityId', entity_id_value,
    'providerEventId', webhook_row.provider_event_id
  );
end;
$$;

revoke all on function public.reconcile_provider_webhook(
  uuid,
  text,
  uuid,
  text,
  jsonb
) from public, anon, authenticated;
grant execute on function public.reconcile_provider_webhook(
  uuid,
  text,
  uuid,
  text,
  jsonb
) to service_role;

comment on function public.reconcile_provider_webhook(
  uuid,
  text,
  uuid,
  text,
  jsonb
) is
  'Reconciles a claimed, signature-verified provider event through company-scoped deterministic writes and append-only audit.';
