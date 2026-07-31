import assert from 'node:assert/strict';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { supabaseCommand } from '../../infra/scripts/common.mjs';

const companyId = '10000000-0000-4000-8000-000000000001';
const technicianId = '10000000-0000-4000-8000-000000000103';
const visitId = '10000000-0000-4000-8000-000000000641';
const jobId = '10000000-0000-4000-8000-000000000631';
const propertyId = '10000000-0000-4000-8000-000000000211';

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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

async function commandHash(command) {
  const canonical = JSON.stringify(
    canonicalize({
      commandType: command.commandType,
      expectedVersion: command.expectedVersion,
      payload: command.payload,
    }),
  );
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Buffer.from(digest).toString('hex');
}

async function functionErrorBody(error) {
  try {
    return await error?.context?.clone().text();
  } catch {
    return '';
  }
}

async function executeCommand(client, commandType, expectedVersion, payload) {
  const command = {
    commandId: randomUUID(),
    commandType,
    expectedVersion,
    payload,
    requestHash: '',
  };
  command.requestHash = await commandHash(command);
  return client.rpc('execute_storyops_command', {
    p_company_id: companyId,
    p_command_id: command.commandId,
    p_command_type: command.commandType,
    p_expected_version: command.expectedVersion,
    p_payload: command.payload,
    p_request_hash: command.requestHash,
  });
}

const { url, anonKey, serviceRoleKey } = localSupabaseEnvironment();
const client = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const service = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
// Test-only bootstrap after the SQL scheduling/dispatch contracts. This media
// canary does not exercise departure; it starts at the first active on-site
// field state and therefore never bypasses or disables the en_route guard.
execFileSync(
  'docker',
  [
    'exec',
    'supabase_db_storyops-ai',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-c',
    `update public.visits set status = 'on_site' where id = '${visitId}'`,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);
const assetId = randomUUID();
const commandId = randomUUID();
const minimalPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const exactBytes = Buffer.from(minimalPngBase64, 'base64');
const tamperedBytes = Buffer.from(exactBytes);
tamperedBytes[40] ^= 1;
const checksumSha256 = createHash('sha256').update(exactBytes).digest('hex');
const objectPath =
  `${companyId}/visits/${visitId}/${assetId}-` + `${checksumSha256.slice(0, 16)}-before.png`;
const payload = {
  entityId: assetId,
  visitId,
  jobId,
  propertyId,
  purpose: 'before',
  objectPath,
  contentType: 'image/png',
  byteSize: exactBytes.byteLength,
  checksumSha256,
  capturedAt: new Date().toISOString(),
  customerVisible: false,
};
const command = {
  commandId,
  commandType: 'media.register',
  expectedVersion: 0,
  payload,
  requestHash: '',
};
command.requestHash = await commandHash(command);

async function uploadAndFinalizeExact(purpose) {
  const mediaAssetId = randomUUID();
  const bytes = Buffer.from(minimalPngBase64, 'base64');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const path =
    `${companyId}/visits/${visitId}/${mediaAssetId}-` + `${checksum.slice(0, 16)}-${purpose}.png`;
  const mediaCommand = {
    commandId: randomUUID(),
    commandType: 'media.register',
    expectedVersion: 0,
    payload: {
      entityId: mediaAssetId,
      visitId,
      jobId,
      propertyId,
      purpose,
      objectPath: path,
      contentType: 'image/png',
      byteSize: bytes.byteLength,
      checksumSha256: checksum,
      capturedAt: new Date().toISOString(),
      customerVisible: false,
    },
    requestHash: '',
  };
  mediaCommand.requestHash = await commandHash(mediaCommand);
  const { error: uploadError } = await client.storage
    .from('job-media')
    .upload(path, new Blob([bytes], { type: 'image/png' }), {
      contentType: 'image/png',
      upsert: false,
    });
  assert.equal(uploadError, null, uploadError?.message);
  const { data: receipt, error } = await client.functions.invoke('field-media-finalize', {
    body: { companyId, command: mediaCommand },
  });
  assert.equal(error, null, await functionErrorBody(error));
  assert.equal(receipt.entityId, mediaAssetId);
  return { assetId: mediaAssetId, objectPath: path };
}

try {
  const { error: authError } = await client.auth.signInWithPassword({
    email: 'technician@storyops.local',
    password: 'StoryOpsDemo1!',
  });
  assert.equal(authError, null, authError?.message);

  const { data: startingWorkspace, error: startingWorkspaceError } = await client.rpc(
    'get_storyops_workspace',
    { p_company_id: companyId },
  );
  assert.equal(startingWorkspaceError, null, startingWorkspaceError?.message);
  let activeVisit = startingWorkspace.visits.find((item) => item.id === visitId);
  assert.ok(activeVisit, 'Assigned visit must be visible to the technician.');
  assert.equal(activeVisit.status, 'on_site', 'Release canary requires an active assigned visit.');

  const { error: tamperedUploadError } = await client.storage
    .from('job-media')
    .upload(objectPath, new Blob([tamperedBytes], { type: 'image/png' }), {
      contentType: 'image/png',
      upsert: false,
    });
  assert.equal(tamperedUploadError, null, tamperedUploadError?.message);

  const { error: checksumError } = await client.functions.invoke('field-media-finalize', {
    body: { companyId, command },
  });
  assert.ok(checksumError, 'Same-length tampered bytes must fail trusted finalization.');
  assert.match(
    `${checksumError.message} ${await functionErrorBody(checksumError)}`,
    /MEDIA_CHECKSUM_MISMATCH|SHA-256/u,
  );
  const { data: rejectedWorkspace, error: rejectedReadError } = await client.rpc(
    'get_storyops_workspace',
    { p_company_id: companyId },
  );
  assert.equal(rejectedReadError, null, rejectedReadError?.message);
  assert.equal(
    rejectedWorkspace.media.some((item) => item.id === assetId),
    false,
    'Checksum rejection must not create metadata.',
  );

  const { error: overwriteError } = await client.storage
    .from('job-media')
    .update(objectPath, new Blob([exactBytes], { type: 'image/png' }), {
      contentType: 'image/png',
      upsert: true,
    });
  assert.ok(overwriteError, 'Authenticated overwrite must be denied.');

  const { error: removeTamperedError } = await service.storage
    .from('job-media')
    .remove([objectPath]);
  assert.equal(removeTamperedError, null, removeTamperedError?.message);
  const { error: exactUploadError } = await client.storage
    .from('job-media')
    .upload(objectPath, new Blob([exactBytes], { type: 'image/png' }), {
      contentType: 'image/png',
      upsert: false,
    });
  assert.equal(exactUploadError, null, exactUploadError?.message);

  const { error: directRpcError } = await client.rpc('execute_storyops_command', {
    p_company_id: companyId,
    p_command_id: command.commandId,
    p_command_type: command.commandType,
    p_expected_version: command.expectedVersion,
    p_payload: command.payload,
    p_request_hash: command.requestHash,
  });
  assert.match(
    directRpcError?.message ?? '',
    /trusted field-media finalizer/u,
    'Generic authenticated media.register must not bypass Edge byte verification.',
  );

  const { data: receipt, error: finalizationError } = await client.functions.invoke(
    'field-media-finalize',
    { body: { companyId, command } },
  );
  assert.equal(finalizationError, null, await functionErrorBody(finalizationError));
  assert.equal(receipt.commandId, command.commandId);
  assert.equal(receipt.entityId, assetId);
  assert.equal(receipt.replayed, false);

  const { data: replay, error: replayError } = await client.functions.invoke(
    'field-media-finalize',
    { body: { companyId, command } },
  );
  assert.equal(replayError, null, await functionErrorBody(replayError));
  assert.equal(replay.entityId, assetId);
  assert.equal(replay.replayed, true);

  const afterMedia = await uploadAndFinalizeExact('after');
  const signatureMedia = await uploadAndFinalizeExact('signature');

  const { data: mediaWorkspace, error: mediaReadError } = await client.rpc(
    'get_storyops_workspace',
    { p_company_id: companyId },
  );
  assert.equal(mediaReadError, null, mediaReadError?.message);
  const media = mediaWorkspace.media.find((item) => item.id === assetId);
  assert.deepEqual(
    {
      id: media?.id,
      byteSize: media?.byteSize,
      objectPath: media?.objectPath,
      syncState: media?.syncState,
    },
    {
      id: assetId,
      byteSize: exactBytes.byteLength,
      objectPath,
      syncState: 'synced',
    },
  );
  const { data: durableBlob, error: durableDownloadError } = await client.storage
    .from('job-media')
    .download(objectPath);
  assert.equal(durableDownloadError, null, durableDownloadError?.message);
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await durableBlob.arrayBuffer()))
      .digest('hex'),
    checksumSha256,
    'The registered row path must still resolve to the exact captured bytes.',
  );

  const { error: registeredOverwriteError } = await client.storage
    .from('job-media')
    .update(objectPath, new Blob([tamperedBytes], { type: 'image/png' }), {
      contentType: 'image/png',
      upsert: true,
    });
  assert.ok(registeredOverwriteError, 'Registered evidence must remain immutable.');

  const { data: workspace, error: workspaceError } = await client.rpc('get_storyops_workspace', {
    p_company_id: companyId,
  });
  assert.equal(workspaceError, null, workspaceError?.message);
  const visit = workspace.visits.find((item) => item.id === visitId);
  assert.ok(visit, 'Assigned visit must be visible to the technician.');
  for (const item of workspace.checklistItems.filter(
    (checklistItem) => checklistItem.visit_id === visitId,
  )) {
    const { error: checklistError } = await executeCommand(
      client,
      'checklist.record',
      item.version,
      {
        entityId: item.id,
        visitId,
        templateItemId: item.template_item_id,
        status: 'complete',
        completedAt: new Date().toISOString(),
      },
    );
    assert.equal(checklistError, null, checklistError?.message);
  }
  const { data: notesReceipt, error: notesError } = await executeCommand(
    client,
    'visit.notes.update',
    visit.version,
    {
      entityId: visitId,
      notes: 'Actual Storage and Edge finalizer release canary completed.',
    },
  );
  assert.equal(notesError, null, notesError?.message);

  const { error: materialError } = await executeCommand(client, 'material.record', 0, {
    entityId: randomUUID(),
    visitId,
    materialId: '10000000-0000-4000-8000-000000000613',
    quantity: '1.0000',
    unit: 'each',
    recordedAt: new Date().toISOString(),
  });
  assert.equal(materialError, null, materialError?.message);

  const { error: signatureError } = await executeCommand(client, 'signature.capture', 0, {
    entityId: randomUUID(),
    visitId,
    signerName: 'Release Canary Customer',
    signerRole: 'customer',
    signedAt: new Date().toISOString(),
    signatureAssetId: signatureMedia.assetId,
    disclosureVersion: 'completion-v1',
  });
  assert.equal(signatureError, null, signatureError?.message);

  const { data: completion, error: completionError } = await executeCommand(
    client,
    'visit.transition',
    notesReceipt.version,
    { entityId: visitId, status: 'completed' },
  );
  assert.equal(completionError, null, completionError?.message);
  assert.equal(completion.entityId, visitId);
  const { data: completedWorkspace, error: completionReadError } = await client.rpc(
    'get_storyops_workspace',
    { p_company_id: companyId },
  );
  assert.equal(completionReadError, null, completionReadError?.message);
  assert.equal(completedWorkspace.visits.find((item) => item.id === visitId)?.status, 'completed');
  assert.ok(afterMedia.objectPath.includes('/visits/'));

  await client.auth.signOut();
  const { error: customerAuthError } = await client.auth.signInWithPassword({
    email: 'customer@storyops.local',
    password: 'StoryOpsDemo1!',
  });
  assert.equal(customerAuthError, null, customerAuthError?.message);
  const customerObjectPath =
    `${companyId}/customers/10000000-0000-4000-8000-000000000201/` +
    `${randomUUID()}-portal-scope.png`;
  const { error: customerUploadError } = await client.storage
    .from('job-media')
    .upload(customerObjectPath, new Blob([exactBytes], { type: 'image/png' }), {
      contentType: 'image/png',
      upsert: false,
    });
  assert.ok(
    customerUploadError,
    'Customer portal Storage writes must remain closed until a quota/finalizer exists.',
  );

  console.log(
    'live offline media integration passed: assigned auth upload, actual-image tamper/direct-RPC/overwrite denial, exact Edge replay, dependent completion, and customer orphan-write denial',
  );
} finally {
  await client.auth.signOut();
}
