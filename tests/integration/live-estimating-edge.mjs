import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, webcrypto } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseCommand } from '../../infra/scripts/common.mjs';

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
  assert.ok(url && anonKey, 'Local Supabase API URL and public key are required.');
  return { url, anonKey };
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

function querySql(sql) {
  return execFileSync(
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
      '-At',
    ],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

async function assertNoFunctionError(error, label) {
  if (!error) return;
  let detail = '';
  try {
    detail = await error.context?.clone().text();
  } catch {
    detail = '';
  }
  assert.fail(`${label}: ${error.message}${detail ? ` — ${detail}` : ''}`);
}

async function command(client, companyId, commandType, expectedVersion, payload, commandId) {
  const body = canonicalize({ commandType, expectedVersion, payload });
  const digest = await webcrypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(body)),
  );
  const requestHash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return client.rpc('execute_storyops_command', {
    p_company_id: companyId,
    p_command_id: commandId,
    p_command_type: commandType,
    p_expected_version: expectedVersion,
    p_payload: payload,
    p_request_hash: requestHash,
  });
}

const companyId = '10000000-0000-4000-8000-000000000001';
const customerId = '10000000-0000-4000-8000-000000000201';
const propertyId = '10000000-0000-4000-8000-000000000211';
const leadId = '10000000-0000-4000-8000-000000000222';
const { url, anonKey } = localSupabaseEnvironment();
const client = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

try {
  const { error: authError } = await client.auth.signInWithPassword({
    email: 'owner@storyops.local',
    password: 'StoryOpsDemo1!',
  });
  assert.equal(authError, null, authError?.message);

  runSql(`
    update public.properties
    set service_address = jsonb_set(service_address, '{postalCode}', '"79999"'::jsonb)
    where id = '${propertyId}'::uuid;
  `);
  try {
    const unmapped = await client.functions.invoke('estimate-workflow', {
      body: { operation: 'context', companyId, propertyId },
    });
    assert.ok(unmapped.error, 'An unmapped property ZIP must fail closed.');
    const unmappedPayload = await unmapped.error.context?.clone().json();
    assert.equal(
      unmappedPayload?.code,
      'TRAVEL_ZONE_UNRESOLVED',
      `Unexpected unmapped-zone response: ${JSON.stringify(unmappedPayload)}`,
    );
  } finally {
    runSql(`
      update public.properties
      set service_address = jsonb_set(service_address, '{postalCode}', '"75219"'::jsonb)
      where id = '${propertyId}'::uuid;
    `);
  }

  const { data: context, error: contextError } = await client.functions.invoke(
    'estimate-workflow',
    { body: { operation: 'context', companyId, propertyId } },
  );
  await assertNoFunctionError(contextError, 'Estimate context');
  assert.equal(context.operation, 'context');
  assert.equal(context.serviceTerms.versionLabel, 'terms-v1');
  assert.equal(context.derivedTravelZone.code, 'DFW-CORE');
  assert.equal(context.derivedTravelZone.source, 'reviewed_postal_code');
  assert.equal(
    context.derivedTravelZone.mappingReviewReference,
    'demo-seed-reviewed-zip-mappings-v1',
  );

  const driveway = context.measurements.find((item) => item.label === 'Driveway');
  const gutter = context.measurements.find((item) => item.label === 'Gutter run');
  const downspouts = context.measurements.find((item) => item.label === 'Downspouts');
  const houseSiding = context.measurements.find((item) => item.label === 'House siding area');
  assert.ok(
    driveway && gutter && downspouts && houseSiding,
    'All human-verified scope evidence is required.',
  );
  assert.deepEqual(driveway.serviceCodes, ['pressure-wash-flatwork']);
  assert.deepEqual(gutter.serviceCodes, ['gutter-cleaning']);
  assert.deepEqual(downspouts.serviceCodes, ['gutter-cleaning']);
  assert.deepEqual(downspouts.addOnCodes, ['downspout-flush']);
  assert.deepEqual(houseSiding.serviceCodes, ['soft-wash-house']);
  assert.deepEqual(houseSiding.addOnCodes, []);
  const { error: wrongScopeError } = await client.functions.invoke('estimate-workflow', {
    body: {
      operation: 'calculate',
      companyId,
      customerId,
      propertyId,
      idempotencyKey: `estimate:${randomUUID()}`,
      services: [
        {
          serviceCode: 'pressure-wash-flatwork',
          measurementId: houseSiding.id,
          attributes: {
            surface: 'concrete',
            soil: 'medium',
            access: 'standard',
            risk: 'standard',
          },
        },
      ],
      travelZoneCode: context.derivedTravelZone.code,
      discount: { kind: 'none' },
    },
  });
  assert.ok(
    wrongScopeError,
    'A same-kind measurement tagged for another service must fail closed.',
  );

  const { error: missingRequiredEvidenceError } = await client.functions.invoke(
    'estimate-workflow',
    {
      body: {
        operation: 'calculate',
        companyId,
        customerId,
        propertyId,
        idempotencyKey: `estimate:${randomUUID()}`,
        services: [
          {
            serviceCode: 'gutter-cleaning',
            measurementId: gutter.id,
            attributes: { soil: 'medium', access: 'standard', risk: 'standard' },
          },
        ],
        travelZoneCode: context.derivedTravelZone.code,
        discount: { kind: 'none' },
      },
    },
  );
  assert.ok(
    missingRequiredEvidenceError,
    'A service missing one catalog-required measurement kind must fail closed.',
  );

  const idempotencyKey = `estimate:${randomUUID()}`;
  const request = {
    operation: 'calculate',
    companyId,
    customerId,
    propertyId,
    leadId,
    idempotencyKey,
    services: [
      {
        serviceCode: 'pressure-wash-flatwork',
        measurementId: driveway.id,
        attributes: {
          surface: 'concrete',
          soil: 'medium',
          access: 'standard',
          risk: 'standard',
        },
      },
      {
        serviceCode: 'gutter-cleaning',
        measurementId: gutter.id,
        supportingMeasurementIds: [downspouts.id],
        attributes: {
          soil: 'medium',
          access: 'standard',
          risk: 'standard',
        },
        addOns: [{ code: 'downspout-flush', measurementId: downspouts.id }],
      },
    ],
    travelZoneCode: context.derivedTravelZone.code,
    discount: { kind: 'percent', value: '20', reason: 'Recorded launch offer' },
  };
  const { data: receipt, error: calculateError } = await client.functions.invoke(
    'estimate-workflow',
    { body: request },
  );
  await assertNoFunctionError(calculateError, 'Estimate calculation');
  assert.equal(receipt.estimateStatus, 'pending_approval');
  assert.equal(receipt.quoteStatus, 'pending_approval');
  assert.ok(receipt.approvalId);

  const storedEvidence = JSON.parse(
    querySql(`
      select jsonb_build_object(
        'calculationInput', estimate.calculation_input,
        'multiplier', line.multiplier::text,
        'sourceMeasurementIds', line.source_measurement_ids
      )::text
      from public.estimates estimate
      join public.estimate_lines line
        on line.company_id = estimate.company_id
        and line.estimate_id = estimate.id
        and line.line_kind = 'service'
        and line.service_code = 'gutter-cleaning'
      where estimate.id = '${receipt.estimateId}'::uuid;
    `),
  );
  const storedGutterInput = storedEvidence.calculationInput.services.find(
    (service) => service.serviceCode === 'gutter-cleaning',
  );
  assert.equal(storedGutterInput.attributes.stories, '2');
  assert.equal(
    storedEvidence.multiplier,
    '1.5525',
    'The published numeric two-story multiplier must be applied deterministically.',
  );
  assert.deepEqual(
    [...storedEvidence.sourceMeasurementIds].sort(),
    [gutter.id, downspouts.id].sort(),
  );

  const { data: replay, error: replayError } = await client.functions.invoke('estimate-workflow', {
    body: request,
  });
  await assertNoFunctionError(replayError, 'Estimate replay');
  assert.equal(replay.estimateId, receipt.estimateId);
  assert.equal(replay.replayed, true);

  const { error: conflictError } = await client.functions.invoke('estimate-workflow', {
    body: {
      ...request,
      discount: { kind: 'none' },
    },
  });
  assert.ok(conflictError, 'Reusing a key with a different intent must fail.');

  const { data: workspace, error: workspaceError } = await client.rpc('get_storyops_workspace', {
    p_company_id: companyId,
  });
  assert.equal(workspaceError, null, workspaceError?.message);
  const approval = workspace.approvals.find((item) => item.id === receipt.approvalId);
  assert.ok(approval, 'The exact pending approval must be in the role-scoped workspace.');
  const approvalCommandId = randomUUID();
  const { data: decision, error: decisionError } = await command(
    client,
    companyId,
    'approval.decide',
    approval.version,
    {
      entityId: receipt.approvalId,
      decision: 'approved',
      decisionNote: 'Integration contract approval.',
    },
    approvalCommandId,
  );
  assert.equal(decisionError, null, decisionError?.message);
  assert.equal(decision.status, 'applied');

  const { data: approvedWorkspace, error: approvedWorkspaceError } = await client.rpc(
    'get_storyops_workspace',
    { p_company_id: companyId },
  );
  assert.equal(approvedWorkspaceError, null, approvedWorkspaceError?.message);
  const estimate = approvedWorkspace.estimates.find((item) => item.id === receipt.estimateId);
  const quote = approvedWorkspace.quotes.find((item) => item.id === receipt.quoteId);
  const convertedLead = approvedWorkspace.leads.find((item) => item.id === leadId);
  assert.equal(estimate.status, 'approved');
  assert.equal(quote.status, 'draft');
  assert.equal(convertedLead.status, 'converted');
  assert.equal(convertedLead.customer_id, customerId);
  assert.equal(convertedLead.property_id, propertyId);

  const quoteCommandId = randomUUID();
  const { data: sent, error: sendError } = await command(
    client,
    companyId,
    'quote.send',
    quote.version,
    { entityId: quote.id },
    quoteCommandId,
  );
  assert.equal(sendError, null, sendError?.message);
  assert.equal(sent.status, 'applied');

  console.log(
    'live estimating integration passed: exact reviewed ZIP mapping, unmapped ZIP fail-closed, RPC-only context, scoped evidence, pricing, replay/conflict, approval, and portal publication',
  );
} finally {
  await client.auth.signOut();
}
