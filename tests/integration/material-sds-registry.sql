\set ON_ERROR_STOP on

begin;

-- This contract deliberately starts in company setup. It proves the reviewed
-- PDF can be registered before a live configuration/baseline exists, avoiding
-- a circular launch dependency, while field usage still requires an active
-- exact baseline binding.
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);

update public.companies
set status = 'setup'
where id = '10000000-0000-4000-8000-000000000001';

create temporary table sds_registry_fixture(
  company_id uuid primary key,
  configuration_id uuid not null,
  configuration jsonb not null,
  configuration_hash text not null,
  command_id uuid not null,
  request_hash text not null,
  checksum_sha256 text not null,
  byte_size bigint not null,
  object_path text
);

insert into sds_registry_fixture(
  company_id,
  configuration_id,
  configuration,
  configuration_hash,
  command_id,
  request_hash,
  checksum_sha256,
  byte_size
)
select
  fixture.company_id,
  fixture.configuration_id,
  fixture.configuration,
  encode(extensions.digest(fixture.configuration::text, 'sha256'), 'hex'),
  fixture.command_id,
  encode(
    extensions.digest(
      array_to_string(
        array[
          'storyops-material-sds-registration-v1',
          fixture.company_id::text,
          'soft-wash-mix',
          'Reviewed exterior cleaner',
          'Example Manufacturer',
          '2026-07-01',
          'application/pdf',
          '9',
          fixture.checksum_sha256,
          'owner-sds-review-2026-07'
        ],
        chr(31)
      ),
      'sha256'
    ),
    'hex'
  ),
  fixture.checksum_sha256,
  9
from (
  select
    '10000000-0000-4000-8000-000000000001'::uuid as company_id,
    '99420000-0000-4000-8000-000000000001'::uuid as configuration_id,
    '99420000-0000-4000-8000-000000000002'::uuid as command_id,
    '3c87d37f1dbea6909f917ce437c390fb8e655a774387d9e69301c0b2283d5b63'
      as checksum_sha256,
    jsonb_build_object(
      'schemaVersion', 'storyops-company-config-v1',
      'identity', '{}'::jsonb,
      'territory', jsonb_build_object(
        'travelZones', jsonb_build_array(jsonb_build_object(
          'code', 'DFW-A',
          'postalCodes', jsonb_build_array('76051')
        )),
        'travelZoneMappingReview', jsonb_build_object(
          'status', 'approved',
          'reviewer', 'SDS contract reviewer',
          'reviewedAt', '2026-07-01T12:00:00.000Z',
          'evidenceReference', 'sds-contract-travel-zone-review'
        )
      ),
      'schedule', '{}'::jsonb,
      'pricing', '{}'::jsonb,
      'people', '{}'::jsonb,
      'resources', '{}'::jsonb,
      'materials', jsonb_build_object(
        'catalog', jsonb_build_array(
          jsonb_build_object(
            'id', 'soft-wash-mix',
            'name', 'Owner-reviewed exterior cleaner',
            'unit', 'gallon',
            'requiresSds', true,
            'sdsStatus', 'approved',
            'sdsReference', 'manufacturer-sds-2026-07',
            'sdsChecksumSha256',
              '3c87d37f1dbea6909f917ce437c390fb8e655a774387d9e69301c0b2283d5b63'
          )
        )
      ),
      'payments', '{}'::jsonb,
      'policies', '{}'::jsonb,
      'engagement', '{}'::jsonb,
      'integrations', '{}'::jsonb
    ) as configuration
) fixture;

insert into public.company_configuration_versions(
  id,
  company_id,
  revision,
  schema_version,
  status,
  configuration,
  configuration_hash,
  created_by
)
select
  configuration_id,
  company_id,
  1,
  'storyops-company-config-v1',
  'draft',
  configuration,
  configuration_hash,
  '10000000-0000-4000-8000-000000000101'
from sds_registry_fixture;

grant select on sds_registry_fixture to authenticated, service_role;

\echo '1/9 live publication fails closed before the exact private SDS is registered'
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.publish_company_configuration(
      (select company_id from sds_registry_fixture),
      '99420000-0000-4000-8000-000000000003',
      1,
      'live',
      'sds-missing-publication-negative-test',
      repeat('a', 64)
    );
  exception when others then
    if position(
      'STORYOPS_SDS_LIVE_PUBLICATION_REQUIRES_EXACT_REGISTRATION'
      in sqlerrm
    ) > 0 then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Live configuration published without exact private SDS evidence';
  end if;
end;
$$;

\echo '2/9 setup owner prepares one exact immutable upload idempotently'
do $$
declare
  receipt jsonb;
  replay jsonb;
begin
  select public.prepare_storyops_material_sds_registration(
    fixture.company_id,
    fixture.command_id,
    'soft-wash-mix',
    'Reviewed exterior cleaner',
    'Example Manufacturer',
    '2026-07-01',
    'application/pdf',
    fixture.byte_size,
    fixture.checksum_sha256,
    'owner-sds-review-2026-07',
    fixture.request_hash
  )
  into receipt
  from sds_registry_fixture fixture;

  select public.prepare_storyops_material_sds_registration(
    fixture.company_id,
    fixture.command_id,
    'soft-wash-mix',
    'Reviewed exterior cleaner',
    'Example Manufacturer',
    '2026-07-01',
    'application/pdf',
    fixture.byte_size,
    fixture.checksum_sha256,
    'owner-sds-review-2026-07',
    fixture.request_hash
  )
  into replay
  from sds_registry_fixture fixture;

  if receipt ->> 'status' <> 'prepared'
    or (receipt ->> 'replayed')::boolean
    or not (replay ->> 'replayed')::boolean
    or receipt ->> 'materialId' is not null
    or receipt ->> 'baselineId' is not null
    or receipt ->> 'checksumSha256'
      <> (select checksum_sha256 from sds_registry_fixture)
  then
    raise exception 'Setup preparation receipt was not exact/idempotent: %, %',
      receipt,
      replay;
  end if;
end;
$$;

reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
update sds_registry_fixture fixture
set object_path = request.object_path
from public.sds_registration_requests request
where request.company_id = fixture.company_id
  and request.command_id = fixture.command_id;
insert into storage.objects(bucket_id, name, metadata)
select
  'sds',
  fixture.object_path,
  jsonb_build_object('size', fixture.byte_size, 'mimetype', 'application/pdf')
from sds_registry_fixture fixture;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);

\echo '3/9 owner finalization cannot bypass trusted byte attestation'
do $$
declare
  blocked boolean := false;
begin
  begin
    perform public.finalize_storyops_material_sds_registration(
      fixture.company_id,
      fixture.command_id,
      fixture.request_hash
    )
    from sds_registry_fixture fixture;
  exception when others then
    if position('STORYOPS_SDS_TRUSTED_BYTE_ATTESTATION_REQUIRED' in sqlerrm) > 0
    then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'SDS finalized without trusted server byte attestation';
  end if;
end;
$$;

do $$
declare
  changed integer;
begin
  update storage.objects object
  set metadata = object.metadata || '{"ownerOverwriteAttempt":true}'::jsonb
  where object.bucket_id = 'sds'
    and object.name = (select object_path from sds_registry_fixture);
  get diagnostics changed = row_count;
  if changed <> 0 then
    raise exception 'Prepared SDS evidence path was not write-once';
  end if;
end;
$$;

\echo '4/9 trusted boundary rejects different same-size bytes/checksum'
reset role;
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000000000',
  true
);
do $$
declare
  verification jsonb;
  blocked boolean := false;
begin
  select public.load_storyops_sds_upload_for_attestation(
    fixture.company_id,
    '10000000-0000-4000-8000-000000000101',
    fixture.command_id,
    fixture.request_hash
  )
  into verification
  from sds_registry_fixture fixture;
  if verification ->> 'objectPath' is null
    or (verification ->> 'byteSize')::bigint <> 9
  then
    raise exception 'Trusted verification facts were incomplete: %', verification;
  end if;

  begin
    perform public.attest_storyops_sds_upload(
      fixture.company_id,
      '10000000-0000-4000-8000-000000000101',
      fixture.command_id,
      fixture.request_hash,
      'de5490d9df4757a63e1a3618def1f5467bfd2629201fbaafb1f6bed303ff3f9b',
      fixture.byte_size,
      'application/pdf'
    )
    from sds_registry_fixture fixture;
  exception when others then
    if position('STORYOPS_SDS_BYTES_MISMATCH' in sqlerrm) > 0 then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Different same-size bytes were accepted as reviewed SDS evidence';
  end if;
end;
$$;

\echo '5/9 exact trusted attestation is finite and replay-safe'
do $$
declare
  receipt jsonb;
  replay jsonb;
begin
  select public.attest_storyops_sds_upload(
    fixture.company_id,
    '10000000-0000-4000-8000-000000000101',
    fixture.command_id,
    fixture.request_hash,
    fixture.checksum_sha256,
    fixture.byte_size,
    'application/pdf'
  )
  into receipt
  from sds_registry_fixture fixture;
  select public.attest_storyops_sds_upload(
    fixture.company_id,
    '10000000-0000-4000-8000-000000000101',
    fixture.command_id,
    fixture.request_hash,
    fixture.checksum_sha256,
    fixture.byte_size,
    'application/pdf'
  )
  into replay
  from sds_registry_fixture fixture;
  if receipt ->> 'status' <> 'attested'
    or (receipt ->> 'replayed')::boolean
    or not (replay ->> 'replayed')::boolean
  then
    raise exception 'Trusted attestation was not finite/replay-safe: %, %',
      receipt,
      replay;
  end if;
end;
$$;

\echo '6/9 owner finalizes immutable exact evidence and replay reconciles'
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  receipt jsonb;
  replay jsonb;
  immutable boolean := false;
begin
  select public.finalize_storyops_material_sds_registration(
    fixture.company_id,
    fixture.command_id,
    fixture.request_hash
  )
  into receipt
  from sds_registry_fixture fixture;
  select public.finalize_storyops_material_sds_registration(
    fixture.company_id,
    fixture.command_id,
    fixture.request_hash
  )
  into replay
  from sds_registry_fixture fixture;

  if receipt ->> 'status' <> 'registered'
    or receipt ->> 'sdsDocumentId' is null
    or (receipt ->> 'replayed')::boolean
    or not (replay ->> 'replayed')::boolean
  then
    raise exception 'Exact SDS finalization did not reconcile: %, %', receipt, replay;
  end if;

  begin
    update public.sds_documents
    set product_name = 'Mutated product'
    where id = (receipt ->> 'sdsDocumentId')::uuid;
  exception when others then
    if position('STORYOPS_SDS_VERSION_IMMUTABLE' in sqlerrm) > 0
      or sqlstate = '42501'
    then
      immutable := true;
    else
      raise;
    end if;
  end;
  if not immutable then
    raise exception 'Registered SDS evidence was mutable';
  end if;
end;
$$;

\echo '7/9 baseline materialization binds the exact pre-registered document'
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  immutable boolean := false;
begin
  if not exists (
    select 1
    from public.sds_upload_attestations attestation
    where attestation.company_id = (
      select company_id from sds_registry_fixture
    )
      and attestation.command_id = (
        select command_id from sds_registry_fixture
      )
      and attestation.consumed_at is not null
  ) then
    raise exception 'Exact SDS finalization did not consume its trusted attestation';
  end if;
  begin
    update public.sds_documents
    set product_name = 'Administrative mutation attempt'
    where registration_command_id = (
      select command_id from sds_registry_fixture
    );
  exception when others then
    if position('STORYOPS_SDS_VERSION_IMMUTABLE' in sqlerrm) > 0 then
      immutable := true;
    else
      raise;
    end if;
  end;
  if not immutable then
    raise exception 'Registered SDS version lacked an immutable database trigger';
  end if;
end;
$$;

update public.company_configuration_versions configuration
set
  status = 'published',
  publication_mode = 'live',
  review_reference = 'material-sds-registry-contract-publication',
  published_by = '10000000-0000-4000-8000-000000000101',
  published_at = now()
where configuration.id = (
  select configuration_id from sds_registry_fixture
);

insert into public.company_operating_baseline_publications(
  id,
  company_id,
  configuration_version_id,
  configuration_revision,
  configuration_hash,
  price_book_id,
  service_terms_id,
  retention_policy_id,
  baseline_hash,
  status,
  review_reference,
  activated_by,
  command_id,
  request_hash
)
select
  '99420000-0000-4000-8000-000000000004',
  fixture.company_id,
  fixture.configuration_id,
  1,
  fixture.configuration_hash,
  '10000000-0000-4000-8000-000000000401',
  '10000000-0000-4000-8000-000000000152',
  '10000000-0000-4000-8000-000000000151',
  repeat('b', 64),
  'active',
  'material-sds-registry-contract-baseline',
  '10000000-0000-4000-8000-000000000101',
  '99420000-0000-4000-8000-000000000005',
  repeat('c', 64)
from sds_registry_fixture fixture;

do $$
begin
  if not exists (
    select 1
    from public.materials material
    join public.sds_documents document
      on document.id = material.sds_document_id
     and document.document_version = material.sds_document_version
     and document.configuration_material_key = material.configuration_material_key
     and document.configuration_revision = material.configuration_revision
     and document.configuration_hash = material.configuration_hash
     and document.checksum_sha256 = material.expected_sds_checksum_sha256
    where material.company_id = (
      select company_id from sds_registry_fixture
    )
      and material.configuration_material_key = 'soft-wash-mix'
      and material.operating_baseline_id =
        '99420000-0000-4000-8000-000000000004'
      and material.active
      and material.requires_sds
  ) then
    raise exception 'Baseline material did not bind the exact registered SDS';
  end if;
end;
$$;

\echo '8/9 field projection exposes exact active evidence and hides missing evidence'
insert into public.materials(
  id,
  company_id,
  sku,
  name,
  unit,
  requires_sds,
  active
)
values (
  '99420000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000001',
  'SDS-MISSING-CONTRACT',
  'Missing SDS contract material',
  'gal',
  true,
  true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  field_reference jsonb;
begin
  field_reference := public.get_storyops_field_reference(
    '10000000-0000-4000-8000-000000000001'
  );
  if not exists (
    select 1
    from jsonb_array_elements(field_reference -> 'materials') material
    where material ->> 'name' = 'Owner-reviewed exterior cleaner'
      and material #>> '{sdsDocument,documentVersion}' = '1'
      and material #>> '{sdsDocument,checksumSha256}'
        = (select checksum_sha256 from sds_registry_fixture)
  ) then
    raise exception 'Exact active SDS was absent from the field projection: %',
      field_reference -> 'materials';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(field_reference -> 'materials') material
    where material ->> 'id' = '99420000-0000-4000-8000-000000000006'
  ) then
    raise exception 'Material without exact SDS leaked into the field projection';
  end if;
end;
$$;

\echo '9/9 stale baseline evidence disappears and material usage fails closed'
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
update public.company_operating_baseline_publications
set
  status = 'retired',
  retired_at = now(),
  updated_at = now()
where id = '99420000-0000-4000-8000-000000000004';

do $$
declare
  blocked boolean := false;
  material_id_value uuid;
begin
  select id
  into material_id_value
  from public.materials
  where company_id = '10000000-0000-4000-8000-000000000001'
    and configuration_material_key = 'soft-wash-mix';
  begin
    insert into public.material_usage(
      company_id,
      visit_id,
      material_id,
      quantity,
      unit,
      recorded_at,
      recorded_by,
      offline_client_id
    )
    values (
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000641',
      material_id_value,
      1,
      'gal',
      now(),
      '10000000-0000-4000-8000-000000000101',
      'sds-stale-baseline-contract'
    );
  exception when others then
    if position(
      'STORYOPS_MATERIAL_USAGE_REQUIRES_CURRENT_REGISTERED_SDS'
      in sqlerrm
    ) > 0 then
      blocked := true;
    else
      raise;
    end if;
  end;
  if not blocked then
    raise exception 'Stale baseline SDS was accepted for field material usage';
  end if;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-4000-8000-000000000101","role":"authenticated"}',
  true
);
select set_config(
  'request.jwt.claim.sub',
  '10000000-0000-4000-8000-000000000101',
  true
);
do $$
declare
  field_reference jsonb;
begin
  field_reference := public.get_storyops_field_reference(
    '10000000-0000-4000-8000-000000000001'
  );
  if exists (
    select 1
    from jsonb_array_elements(field_reference -> 'materials') material
    where material ->> 'name' = 'Owner-reviewed exterior cleaner'
  ) then
    raise exception 'Stale baseline SDS remained in the field projection';
  end if;
end;
$$;

rollback;
