#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const image = 'denoland/deno:2.5.6';
const entrypoints = [
  'supabase/functions/ai-approved-action/index.ts',
  'supabase/functions/ai-office/index.ts',
  'supabase/functions/dispatch-clearance/index.ts',
  'supabase/functions/estimate-workflow/index.ts',
  'supabase/functions/field-media-finalize/index.ts',
  'supabase/functions/golden-path/index.ts',
  'supabase/functions/identity-provisioning/index.ts',
  'supabase/functions/integration-health/index.ts',
  'supabase/functions/lead-intake/index.ts',
  'supabase/functions/photo-analyze/index.ts',
  'supabase/functions/post-service/index.ts',
  'supabase/functions/post-service-worker/index.ts',
  'supabase/functions/property-geocode/index.ts',
  'supabase/functions/provider-webhook/index.ts',
  'supabase/functions/scope-photo-cleanup/index.ts',
  'supabase/functions/scope-photo-workflow/index.ts',
  'supabase/functions/scheduling-evidence/index.ts',
  'supabase/functions/scheduling-reconciliation/index.ts',
  'supabase/functions/scheduling-suggestions/index.ts',
  'supabase/functions/sds-registration/index.ts',
  'supabase/functions/transactional-outbound-worker/index.ts',
  'supabase/functions/trusted-pilot-proof/index.ts',
];

const cacheDirectory = join(process.cwd(), 'node_modules', '.cache', 'storyops-deno');
mkdirSync(cacheDirectory, { recursive: true });

function runDeno(arguments_) {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--volume',
      `${process.cwd()}:/workspace:ro`,
      '--volume',
      `${cacheDirectory}:/deno-dir`,
      '--env',
      'DENO_DIR=/deno-dir',
      '--workdir',
      '/workspace',
      image,
      'deno',
      ...arguments_,
    ],
    { stdio: 'inherit' },
  );

  if (result.error) {
    console.error(`Unable to launch the pinned Deno checker: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const lockedConfig = [
  '--config',
  'supabase/functions/deno.json',
  '--lock',
  'supabase/functions/deno.lock',
  '--frozen',
];
runDeno(['check', ...lockedConfig, ...entrypoints]);
runDeno(['lint', 'supabase/functions']);
runDeno([
  'test',
  ...lockedConfig,
  'supabase/functions/ai-approved-action/contracts_test.ts',
  'supabase/functions/ai-office/activation_test.ts',
  'supabase/functions/ai-office/authoritative-facts_test.ts',
  'supabase/functions/ai-office/live-office-contracts_test.ts',
  'supabase/functions/ai-office/server-record-tools_test.ts',
  'supabase/functions/dispatch-clearance/contracts_test.ts',
  'supabase/functions/estimate-workflow/contracts_test.ts',
  'supabase/functions/field-media-finalize/contracts_test.ts',
  'supabase/functions/golden-path/contracts_test.ts',
  'supabase/functions/identity-provisioning/contracts_test.ts',
  'supabase/functions/identity-provisioning/invite-authority_test.ts',
  'supabase/functions/integration-health/contracts_test.ts',
  'supabase/functions/lead-intake/contracts_test.ts',
  'supabase/functions/post-service/contracts_test.ts',
  'supabase/functions/post-service-worker/contracts_test.ts',
  'supabase/functions/property-geocode/contracts_test.ts',
  'supabase/functions/provider-webhook/contracts_test.ts',
  'supabase/functions/scope-photo-cleanup/contracts_test.ts',
  'supabase/functions/scope-photo-workflow/contracts_test.ts',
  'supabase/functions/scheduling-evidence/contracts_test.ts',
  'supabase/functions/scheduling-evidence/routeContext_test.ts',
  'supabase/functions/scheduling-reconciliation/contracts_test.ts',
  'supabase/functions/sds-registration/contracts_test.ts',
  'supabase/functions/transactional-outbound-worker/contracts_test.ts',
  'supabase/functions/trusted-pilot-proof/contracts_test.ts',
]);
