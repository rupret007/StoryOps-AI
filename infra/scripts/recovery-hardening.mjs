import { createHash } from 'node:crypto';

export const REQUIRED_STORYOPS_MIGRATIONS = Object.freeze([
  '20260728000000',
  '20260728010000',
  '20260728020000',
  '20260728030000',
  '20260728040000',
  '20260728050000',
  '20260728060000',
  '20260728070000',
  '20260728080000',
  '20260728090000',
  '20260728100000',
  '20260728110000',
]);

export const REQUIRED_STORYOPS_MIGRATION = REQUIRED_STORYOPS_MIGRATIONS.at(-1);

export const STORYOPS_SCHEMA_SENTINELS = Object.freeze([
  'public.companies',
  'public.audit_events',
  'public.post_service_followups',
  'public.media_upload_attestations',
]);

const STORYOPS_SCHEMA_PATTERNS = Object.freeze([
  {
    name: 'public.companies',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"companies"|companies)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.audit_events',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"audit_events"|audit_events)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.post_service_followups',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"post_service_followups"|post_service_followups)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.media_upload_attestations',
    pattern:
      /\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:"public"|public)\s*\.\s*(?:"media_upload_attestations"|media_upload_attestations)(?![a-z0-9_])/iu,
  },
  {
    name: 'public.referrals_one_invite_per_source_invoice_idx',
    pattern: /\breferrals_one_invite_per_source_invoice_idx\b/iu,
  },
  {
    name: 'public.get_storyops_setup_state',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"get_storyops_setup_state"|get_storyops_setup_state)\s*\(/iu,
  },
  {
    name: 'public.begin_storyops_post_service_submission',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"begin_storyops_post_service_submission"|begin_storyops_post_service_submission)\s*\(/iu,
  },
  {
    name: 'public.finalize_storyops_media_upload',
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"public"|public)\s*\.\s*(?:"finalize_storyops_media_upload"|finalize_storyops_media_upload)\s*\(/iu,
  },
]);

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseCliJson(output, label) {
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} returned an invalid JSON object.`);
  }
  return parsed;
}

function estimatedRowCount(value, tableName) {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(normalized)) {
    throw new Error(`Table statistics returned an invalid estimate for "${tableName}".`);
  }
  return normalized < 0 ? null : normalized;
}

export function storyOpsSourceEvidence({
  migrationOutput,
  tableStatsOutput,
  observedAt = new Date().toISOString(),
}) {
  const migrationResult = parseCliJson(migrationOutput, 'Supabase migration list');
  if (!Array.isArray(migrationResult.migrations)) {
    throw new Error('Supabase migration list did not include a migrations array.');
  }
  const appliedVersions = migrationResult.migrations
    .map((migration) => migration?.remote)
    .filter((version) => typeof version === 'string' && /^\d{14}$/u.test(version))
    .sort();
  if (new Set(appliedVersions).size !== appliedVersions.length) {
    throw new Error('Supabase migration list contains duplicate applied versions.');
  }
  const missingMigrations = REQUIRED_STORYOPS_MIGRATIONS.filter(
    (version) => !appliedVersions.includes(version),
  );
  const unexpectedMigrations = appliedVersions.filter(
    (version) => !REQUIRED_STORYOPS_MIGRATIONS.includes(version),
  );
  if (missingMigrations.length > 0 || unexpectedMigrations.length > 0) {
    const details = [
      missingMigrations.length > 0 ? `missing ${missingMigrations.join(', ')}` : null,
      unexpectedMigrations.length > 0 ? `unexpected ${unexpectedMigrations.join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(
      `Refusing backup: applied StoryOps migration set does not match this release (${details}).`,
    );
  }

  const statsResult = parseCliJson(tableStatsOutput, 'Supabase table statistics');
  if (!Array.isArray(statsResult.rows)) {
    throw new Error('Supabase table statistics did not include a rows array.');
  }
  const tableCounts = new Map();
  for (const row of statsResult.rows) {
    if (!row || typeof row.name !== 'string' || !row.name.startsWith('public.')) continue;
    if (tableCounts.has(row.name)) {
      throw new Error(`Supabase table statistics repeat "${row.name}".`);
    }
    tableCounts.set(row.name, estimatedRowCount(row.estimated_row_count, row.name));
  }
  const missingTables = STORYOPS_SCHEMA_SENTINELS.filter((name) => !tableCounts.has(name));
  if (missingTables.length > 0) {
    throw new Error(
      `Refusing backup: StoryOps source schema is missing sentinel table(s): ${missingTables.join(', ')}.`,
    );
  }

  return {
    requiredMigration: REQUIRED_STORYOPS_MIGRATION,
    requiredMigrationCount: REQUIRED_STORYOPS_MIGRATIONS.length,
    requiredMigrationSetFingerprint: {
      algorithm: 'sha256',
      value: sha256Text(REQUIRED_STORYOPS_MIGRATIONS.join('\n')),
    },
    appliedMigrationCount: appliedVersions.length,
    latestAppliedMigration: appliedVersions.at(-1),
    migrationSetFingerprint: {
      algorithm: 'sha256',
      value: sha256Text(appliedVersions.join('\n')),
    },
    estimatedTableCounts: {
      method: 'supabase-inspect-db-table-stats',
      observedAt,
      transactionallyConsistentWithDump: false,
      unavailableEstimateValue: null,
      tables: Object.fromEntries(
        [...tableCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
  };
}

export function validateStoryOpsSchemaDump(schemaSql) {
  if (typeof schemaSql !== 'string' || schemaSql.trim().length === 0) {
    throw new Error('StoryOps schema dump is empty.');
  }
  const missing = STORYOPS_SCHEMA_PATTERNS.filter(({ pattern }) => !pattern.test(schemaSql)).map(
    ({ name }) => name,
  );
  if (missing.length > 0) {
    throw new Error(
      `Refusing backup: schema dump is missing StoryOps sentinel(s): ${missing.join(', ')}.`,
    );
  }
  return STORYOPS_SCHEMA_PATTERNS.map(({ name }) => name);
}

function normalizedFileSize(value, label) {
  if (value === null || value === undefined) return null;
  const normalized =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} has an invalid file-size limit.`);
  }
  return normalized;
}

function normalizedMimeTypes(value, label) {
  if (value === null || value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.some(
      (mimeType) => typeof mimeType !== 'string' || mimeType.trim() !== mimeType || !mimeType,
    )
  ) {
    throw new Error(`${label} has invalid allowed MIME types.`);
  }
  const normalized = [...new Set(value)].sort();
  if (normalized.length !== value.length) {
    throw new Error(`${label} repeats an allowed MIME type.`);
  }
  return normalized;
}

function manifestBucketPolicy(bucket) {
  if (
    !bucket ||
    typeof bucket.id !== 'string' ||
    !bucket.id ||
    bucket.id.trim() !== bucket.id ||
    typeof bucket.public !== 'boolean'
  ) {
    throw new Error('Backup Storage manifest contains an invalid bucket record.');
  }
  return {
    id: bucket.id,
    public: bucket.public,
    fileSizeLimit: normalizedFileSize(bucket.fileSizeLimit, `Backup Storage bucket "${bucket.id}"`),
    allowedMimeTypes: normalizedMimeTypes(
      bucket.allowedMimeTypes,
      `Backup Storage bucket "${bucket.id}"`,
    ),
  };
}

function existingBucketPolicy(bucket) {
  if (!bucket || typeof bucket.id !== 'string' || !bucket.id) {
    throw new Error('Target Storage returned an invalid bucket record.');
  }
  if (typeof bucket.public !== 'boolean') {
    throw new Error(`Target Storage bucket "${bucket.id}" has an invalid public policy.`);
  }
  return {
    id: bucket.id,
    public: bucket.public,
    fileSizeLimit: normalizedFileSize(
      bucket.file_size_limit ?? bucket.fileSizeLimit,
      `Target Storage bucket "${bucket.id}"`,
    ),
    allowedMimeTypes: normalizedMimeTypes(
      bucket.allowed_mime_types ?? bucket.allowedMimeTypes,
      `Target Storage bucket "${bucket.id}"`,
    ),
  };
}

export function validateStorageBucketManifest(buckets) {
  if (!Array.isArray(buckets)) {
    throw new Error('Backup Storage manifest has no bucket list.');
  }
  const policies = buckets.map(manifestBucketPolicy);
  const ids = policies.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Backup Storage manifest repeats a bucket id.');
  }
  return policies;
}

export function storageBucketPolicyDrift({ manifestBuckets, existingBuckets, targetHost }) {
  if (typeof targetHost !== 'string' || !targetHost) {
    throw new Error('Storage policy comparison requires the exact target host.');
  }
  const expectedPolicies = validateStorageBucketManifest(manifestBuckets);
  if (!Array.isArray(existingBuckets)) {
    throw new Error('Target Storage bucket list is invalid.');
  }
  const actualPolicies = existingBuckets.map(existingBucketPolicy);
  const actualById = new Map();
  for (const policy of actualPolicies) {
    if (actualById.has(policy.id)) {
      throw new Error(`Target Storage repeats bucket "${policy.id}".`);
    }
    actualById.set(policy.id, policy);
  }

  const drift = [];
  for (const expected of expectedPolicies) {
    const actual = actualById.get(expected.id);
    if (!actual) continue;
    if (
      actual.public !== expected.public ||
      actual.fileSizeLimit !== expected.fileSizeLimit ||
      JSON.stringify(actual.allowedMimeTypes) !== JSON.stringify(expected.allowedMimeTypes)
    ) {
      drift.push({ bucketId: expected.id, expected, actual });
    }
  }
  drift.sort((left, right) => left.bucketId.localeCompare(right.bucketId));
  return {
    drift,
    confirmationSha256:
      drift.length === 0
        ? null
        : sha256Text(
            JSON.stringify({
              targetHost,
              drift,
            }),
          ),
  };
}

export function assertStoragePolicyDriftConfirmation({
  comparison,
  allowPolicyDrift,
  policyDriftConfirmation,
}) {
  if (!comparison || !Array.isArray(comparison.drift)) {
    throw new Error('Storage bucket policy comparison result is invalid.');
  }
  if (comparison.drift.length === 0) return [];
  const bucketIds = comparison.drift.map(({ bucketId }) => bucketId);
  if (
    !allowPolicyDrift ||
    !policyDriftConfirmation ||
    policyDriftConfirmation !== comparison.confirmationSha256
  ) {
    throw new Error(
      `Storage bucket policy drift detected for ${bucketIds.join(', ')}. No Storage changes were made. After review, preserve the existing policies only with --allow-storage-policy-drift --confirm-storage-policy-drift ${comparison.confirmationSha256}.`,
    );
  }
  return bucketIds;
}
