import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { supabaseCommand } from '../../infra/scripts/common.mjs';

const companyId = '99421000-0000-4000-8000-000000000010';
const ownerId = '10000000-0000-4000-8000-000000000101';
const membershipId = '99421000-0000-4000-8000-000000000011';
const configurationId = '99421000-0000-4000-8000-000000000001';
const validCommandId = '99421000-0000-4000-8000-000000000002';
const tamperCommandId = '99421000-0000-4000-8000-000000000003';
const materialKey = 'soft-wash-mix-edge';
const tamperMaterialKey = 'soft-wash-mix-tamper';
const exactBytes = Buffer.from('%PDF-test');
const sameSizeWrongBytes = Buffer.from('%PDF-tesu');
const checksumSha256 = createHash('sha256').update(exactBytes).digest('hex');
const objectPath = `${companyId}/materials/${materialKey}/sds/v1-${checksumSha256}.pdf`;
const metadata = {
  materialConfigurationKey: materialKey,
  productName: 'Edge-reviewed exterior cleaner',
  manufacturer: 'Example Manufacturer',
  revisionDate: '2026-07-01',
  contentType: 'application/pdf',
  byteSize: exactBytes.byteLength,
  checksumSha256,
  reviewReference: 'owner-edge-sds-review-2026-07',
};
const tamperMetadata = {
  ...metadata,
  materialConfigurationKey: tamperMaterialKey,
  productName: 'Tamper-test exterior cleaner',
  reviewReference: 'owner-edge-sds-tamper-review-2026-07',
};
const tamperObjectPath = `${companyId}/materials/${tamperMaterialKey}/sds/v1-${checksumSha256}.pdf`;
function registrationRequestHash(value) {
  return createHash('sha256')
    .update(
      [
        'storyops-material-sds-registration-v1',
        companyId,
        value.materialConfigurationKey,
        value.productName,
        value.manufacturer,
        value.revisionDate,
        value.contentType,
        String(value.byteSize),
        value.checksumSha256,
        value.reviewReference,
      ].join('\u001f'),
    )
    .digest('hex');
}
const requestHash = registrationRequestHash(metadata);
const tamperRequestHash = registrationRequestHash(tamperMetadata);

function localSupabaseEnvironment() {
  const cli = supabaseCommand();
  const output = execFileSync(cli.command, [...cli.prefix, 'status', '-o', 'env'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const values = Object.fromEntries(
    output
      .split(/\r?\n/u)
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/u))
      .filter(Boolean)
      .map((match) => [match[1], match[2]]),
  );
  const url = values.API_URL;
  const anonKey = values.ANON_KEY ?? values.PUBLISHABLE_KEY;
  const serviceRoleKey = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
  assert.ok(url && anonKey && serviceRoleKey, 'Local Supabase URL and keys are required.');
  return { url, anonKey, serviceRoleKey };
}

function runSql(sql) {
  execFileSync(
    'docker',
    [
      'exec',
      '-i',
      'supabase_db_storyops-ai',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: sql, stdio: ['pipe', 'ignore', 'pipe'] },
  );
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function functionErrorPayload(error) {
  try {
    return await error?.context?.clone().json();
  } catch {
    return undefined;
  }
}

const configuration = {
  schemaVersion: 'storyops-company-config-v1',
  identity: {},
  territory: {
    travelZones: [{ code: 'DFW-A', postalCodes: ['76051'] }],
    travelZoneMappingReview: {
      status: 'approved',
      reviewer: 'SDS Edge contract reviewer',
      reviewedAt: '2026-07-01T12:00:00.000Z',
      evidenceReference: 'sds-edge-contract-travel-zone-review',
    },
  },
  schedule: {},
  pricing: {},
  people: {},
  resources: {},
  materials: {
    catalog: [
      {
        id: materialKey,
        name: 'Edge-reviewed exterior cleaner',
        unit: 'gallon',
        requiresSds: true,
        sdsStatus: 'approved',
        sdsReference: 'manufacturer-edge-sds-2026-07',
        sdsChecksumSha256: checksumSha256,
      },
      {
        id: tamperMaterialKey,
        name: 'Tamper-test exterior cleaner',
        unit: 'gallon',
        requiresSds: true,
        sdsStatus: 'approved',
        sdsReference: 'manufacturer-edge-sds-tamper-2026-07',
        sdsChecksumSha256: checksumSha256,
      },
    ],
  },
  payments: {},
  policies: {},
  engagement: {},
  integrations: {},
};

const cleanupSql = `
begin;
set local session_replication_role = replica;
delete from public.audit_events
where company_id = ${sqlLiteral(companyId)}::uuid
  and (
    request_id in (
      ${sqlLiteral(validCommandId)},
      ${sqlLiteral(tamperCommandId)}
    )
    or entity_id in (
      select id
      from public.sds_registration_requests
      where company_id = ${sqlLiteral(companyId)}::uuid
        and command_id in (
          ${sqlLiteral(validCommandId)}::uuid,
          ${sqlLiteral(tamperCommandId)}::uuid
        )
    )
  );
delete from public.sds_upload_attestations
where company_id = ${sqlLiteral(companyId)}::uuid
  and command_id in (
    ${sqlLiteral(validCommandId)}::uuid,
    ${sqlLiteral(tamperCommandId)}::uuid
  );
delete from public.sds_registration_requests
where company_id = ${sqlLiteral(companyId)}::uuid
  and command_id in (
    ${sqlLiteral(validCommandId)}::uuid,
    ${sqlLiteral(tamperCommandId)}::uuid
  );
delete from public.sds_documents
where company_id = ${sqlLiteral(companyId)}::uuid
  and registration_command_id in (
    ${sqlLiteral(validCommandId)}::uuid,
    ${sqlLiteral(tamperCommandId)}::uuid
  );
delete from public.idempotency_keys
where company_id = ${sqlLiteral(companyId)}::uuid
  and scope = 'material-sds-registration-v1'
  and key in (
    ${sqlLiteral(validCommandId)},
    ${sqlLiteral(tamperCommandId)}
  );
delete from public.company_configuration_versions
where id = ${sqlLiteral(configurationId)}::uuid
  and company_id = ${sqlLiteral(companyId)}::uuid;
delete from storage.objects
where bucket_id = 'sds'
  and name in (
    ${sqlLiteral(objectPath)},
    ${sqlLiteral(tamperObjectPath)}
  );
delete from public.company_memberships
where id = ${sqlLiteral(membershipId)}::uuid
  and company_id = ${sqlLiteral(companyId)}::uuid;
delete from public.companies
where id = ${sqlLiteral(companyId)}::uuid;
commit;
`;

const bootstrapSql = `
insert into public.companies(id, name, timezone, settings, status)
values (
  ${sqlLiteral(companyId)}::uuid,
  'WashOps SDS Edge Canary',
  'America/Chicago',
  '{}'::jsonb,
  'active'
);
insert into public.company_memberships(id, company_id, user_id, role)
values (
  ${sqlLiteral(membershipId)}::uuid,
  ${sqlLiteral(companyId)}::uuid,
  ${sqlLiteral(ownerId)}::uuid,
  'owner'
);
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
  ${sqlLiteral(configurationId)}::uuid,
  ${sqlLiteral(companyId)}::uuid,
  1,
  'storyops-company-config-v1',
  'draft',
  payload.configuration,
  encode(extensions.digest(payload.configuration::text, 'sha256'), 'hex'),
  ${sqlLiteral(ownerId)}::uuid
from (
  select ${sqlLiteral(JSON.stringify(configuration))}::jsonb as configuration
) payload;
`;

const { url, anonKey, serviceRoleKey } = localSupabaseEnvironment();
const client = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const service = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

await service.storage.from('sds').remove([objectPath, tamperObjectPath]);
runSql(cleanupSql);

try {
  runSql(bootstrapSql);
  const { error: authError } = await client.auth.signInWithPassword({
    email: 'owner@storyops.local',
    password: 'StoryOpsDemo1!',
  });
  assert.equal(authError, null, authError?.message);

  const { data: tamperPrepared, error: tamperPrepareError } = await client.rpc(
    'prepare_storyops_material_sds_registration',
    {
      p_company_id: companyId,
      p_command_id: tamperCommandId,
      p_material_configuration_key: tamperMetadata.materialConfigurationKey,
      p_product_name: tamperMetadata.productName,
      p_manufacturer: tamperMetadata.manufacturer,
      p_revision_date: tamperMetadata.revisionDate,
      p_content_type: tamperMetadata.contentType,
      p_byte_size: tamperMetadata.byteSize,
      p_checksum_sha256: tamperMetadata.checksumSha256,
      p_review_reference: tamperMetadata.reviewReference,
      p_request_hash: tamperRequestHash,
    },
  );
  assert.equal(tamperPrepareError, null, tamperPrepareError?.message);
  assert.equal(tamperPrepared.status, 'prepared');
  assert.equal(tamperPrepared.objectPath, tamperObjectPath);

  const { error: tamperedUploadError } = await client.storage
    .from('sds')
    .upload(tamperObjectPath, new Blob([sameSizeWrongBytes], { type: 'application/pdf' }), {
      contentType: 'application/pdf',
      upsert: false,
    });
  assert.equal(tamperedUploadError, null, tamperedUploadError?.message);

  const tampered = await client.functions.invoke('sds-registration', {
    body: {
      companyId,
      commandId: tamperCommandId,
      requestHash: tamperRequestHash,
    },
  });
  assert.ok(tampered.error, 'Different same-size SDS bytes unexpectedly passed attestation.');
  assert.equal(
    (await functionErrorPayload(tampered.error))?.code,
    'SDS_BYTES_MISMATCH',
    'The trusted function did not classify same-size byte tampering.',
  );

  const { data: prepared, error: prepareError } = await client.rpc(
    'prepare_storyops_material_sds_registration',
    {
      p_company_id: companyId,
      p_command_id: validCommandId,
      p_material_configuration_key: metadata.materialConfigurationKey,
      p_product_name: metadata.productName,
      p_manufacturer: metadata.manufacturer,
      p_revision_date: metadata.revisionDate,
      p_content_type: metadata.contentType,
      p_byte_size: metadata.byteSize,
      p_checksum_sha256: metadata.checksumSha256,
      p_review_reference: metadata.reviewReference,
      p_request_hash: requestHash,
    },
  );
  assert.equal(prepareError, null, prepareError?.message);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.objectPath, objectPath);
  assert.equal(prepared.materialId, null);
  assert.equal(prepared.baselineId, null);

  const { error: exactUploadError } = await client.storage
    .from('sds')
    .upload(objectPath, new Blob([exactBytes], { type: 'application/pdf' }), {
      contentType: 'application/pdf',
      upsert: false,
    });
  assert.equal(exactUploadError, null, exactUploadError?.message);

  const { data: attested, error: attestationError } = await client.functions.invoke(
    'sds-registration',
    { body: { companyId, commandId: validCommandId, requestHash } },
  );
  assert.equal(
    attestationError,
    null,
    JSON.stringify(await functionErrorPayload(attestationError)),
  );
  assert.equal(attested.status, 'attested');
  assert.equal(attested.checksumSha256, checksumSha256);
  assert.equal(attested.byteSize, exactBytes.byteLength);

  const { data: finalized, error: finalizeError } = await client.rpc(
    'finalize_storyops_material_sds_registration',
    {
      p_company_id: companyId,
      p_command_id: validCommandId,
      p_request_hash: requestHash,
    },
  );
  assert.equal(finalizeError, null, finalizeError?.message);
  assert.equal(finalized.status, 'registered');
  assert.match(finalized.sdsDocumentId, /^[0-9a-f-]{36}$/u);

  const { data: replay, error: replayError } = await client.rpc(
    'finalize_storyops_material_sds_registration',
    {
      p_company_id: companyId,
      p_command_id: validCommandId,
      p_request_hash: requestHash,
    },
  );
  assert.equal(replayError, null, replayError?.message);
  assert.equal(replay.sdsDocumentId, finalized.sdsDocumentId);
  assert.equal(replay.replayed, true);

  const { data: registry, error: registryError } = await client.rpc(
    'get_storyops_material_sds_registry',
    { p_company_id: companyId },
  );
  assert.equal(registryError, null, registryError?.message);
  const registered = registry.materials.find(
    (material) => material.configurationKey === materialKey,
  );
  assert.equal(registered?.registrationStatus, 'registered');
  assert.equal(registered?.sdsDocument?.checksumSha256, checksumSha256);
  assert.equal(registered?.sdsDocument?.documentVersion, 1);
} finally {
  await service.storage.from('sds').remove([objectPath, tamperObjectPath]);
  runSql(cleanupSql);
}

process.stdout.write(
  'SDS Edge canary passed: same-size tamper rejected and exact private PDF registered.\n',
);
