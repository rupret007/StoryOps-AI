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

  const { data: context, error: contextError } = await client.functions.invoke(
    'estimate-workflow',
    { body: { operation: 'context', companyId, propertyId } },
  );
  await assertNoFunctionError(contextError, 'Estimate context');
  assert.equal(context.operation, 'context');
  assert.equal(context.serviceTerms.versionLabel, 'terms-v1');
  assert.equal(context.derivedTravelZone.code, 'DFW-CORE');

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
        attributes: {
          soil: 'medium',
          access: 'standard',
          risk: 'standard',
        },
        addOns: [{ code: 'downspout-flush', measurementId: downspouts.id }],
      },
    ],
    travelZoneCode: context.derivedTravelZone.code,
    discount: { kind: 'percent', value: '5', reason: 'Recorded launch offer' },
  };
  const { data: receipt, error: calculateError } = await client.functions.invoke(
    'estimate-workflow',
    { body: request },
  );
  await assertNoFunctionError(calculateError, 'Estimate calculation');
  assert.equal(receipt.estimateStatus, 'pending_approval');
  assert.equal(receipt.quoteStatus, 'pending_approval');
  assert.ok(receipt.approvalId);

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
    'live estimating integration passed: RPC-only context, scoped evidence, converted lead, pricing, replay/conflict, exact approval, and quote send',
  );
} finally {
  await client.auth.signOut();
}
