const POLICY_LINE = /^CREATE POLICY "([a-z][a-z0-9_]*)" ON "storage"\."(objects|buckets)" .+;$/u;

export const REQUIRED_STORYOPS_STORAGE_POLICIES = Object.freeze([
  'company_assets_owner_insert',
  'company_assets_owner_update',
  'company_assets_select',
  'job_media_insert',
  'job_media_select',
  'sds_owner_insert',
  'sds_select',
]);

export const REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS = Object.freeze(['auth', 'public', 'private']);

export const REQUIRED_STORYOPS_DATA_DUMP_EXCLUSIONS = Object.freeze([
  'private.dispatch_current_origin_ephemera',
  'private.dispatch_current_origin_verifiers',
  'private.dispatch_origin_purge_worker_health',
]);

const RETIRED_STORYOPS_STORAGE_POLICIES = Object.freeze(['job_media_update', 'sds_owner_update']);

const REQUIRED_POLICY_FRAGMENTS = Object.freeze({
  company_assets_owner_insert: [
    'FOR INSERT',
    "'company-assets'",
    '"public"."lock_storyops_active_company"(',
    '"public"."has_company_role"(',
  ],
  company_assets_owner_update: [
    'FOR UPDATE',
    "'company-assets'",
    '"public"."lock_storyops_active_company"(',
    '"public"."has_company_role"(',
  ],
  company_assets_select: ['FOR SELECT', "'company-assets'", '"public"."has_company_role"('],
  job_media_insert: ['FOR INSERT', "'job-media'", '"public"."can_upload_job_media_object"('],
  job_media_select: [
    'FOR SELECT',
    "'job-media'",
    '"public"."can_read_job_media_object"(',
    '"public"."can_upload_job_media_object"(',
  ],
  sds_owner_insert: ['FOR INSERT', "'sds'", '"public"."can_upload_storyops_sds_object"('],
  sds_select: ['FOR SELECT', "'sds'", '"public"."has_company_role"('],
});

function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function parsePolicyLines(value, sourceName) {
  const createPolicyLines = value
    .split(/\r?\n/u)
    .filter((line) => /^\s*CREATE POLICY\b/u.test(line));
  const records = [];
  const seenNames = new Set();
  for (const line of createPolicyLines) {
    const match = POLICY_LINE.exec(line);
    if (!match) {
      throw new Error(
        `${sourceName} contains a multiline, malformed, or non-allowlisted Storage policy statement.`,
      );
    }
    const [, name, table] = match;
    if (
      (line.match(/;/gu) || []).length !== 1 ||
      line.includes('--') ||
      line.includes('/*') ||
      line.includes('*/')
    ) {
      throw new Error(`${sourceName} Storage policy "${name}" is not one complete SQL statement.`);
    }
    if (seenNames.has(name)) {
      throw new Error(`${sourceName} repeats Storage policy "${name}".`);
    }
    seenNames.add(name);
    const missingFragments = (REQUIRED_POLICY_FRAGMENTS[name] || []).filter(
      (fragment) => !line.includes(fragment),
    );
    if (missingFragments.length > 0 || /\b(?:USING|WITH CHECK) \(\s*true\s*\)/iu.test(line)) {
      throw new Error(
        `${sourceName} Storage policy "${name}" does not match its release guard contract.`,
      );
    }
    records.push({ name, table, statement: line });
  }
  return records;
}

function assertReleasePolicyInventory(records, sourceName) {
  const names = sorted(records.map((record) => record.name));
  const expected = sorted(REQUIRED_STORYOPS_STORAGE_POLICIES);
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !names.includes(name));
    const unexpected = names.filter((name) => !expected.includes(name));
    throw new Error(
      `${sourceName} Storage policy inventory does not match this release` +
        `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}` +
        `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(', ')}` : ''}.`,
    );
  }
  for (const retired of RETIRED_STORYOPS_STORAGE_POLICIES) {
    if (names.includes(retired)) {
      throw new Error(`${sourceName} retains retired Storage policy "${retired}".`);
    }
  }
}

export function extractStoryOpsStoragePolicyDump(storageSchemaDump) {
  const records = parsePolicyLines(storageSchemaDump, 'Storage schema dump');
  assertReleasePolicyInventory(records, 'Storage schema dump');
  return {
    policyNames: sorted(records.map((record) => record.name)),
    sql: [
      '-- StoryOps application policies for Supabase managed Storage tables.',
      '-- Buckets, object metadata, multipart metadata, and object bytes are restored separately.',
      ...records
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
        .map((record) => record.statement),
      '',
    ].join('\n'),
  };
}

export function validateStoryOpsStoragePolicyDump(policyDump) {
  const records = parsePolicyLines(policyDump, 'Storage policy dump');
  assertReleasePolicyInventory(records, 'Storage policy dump');
  const remaining = policyDump
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith('--') && line.trim() !== '' && !POLICY_LINE.test(line));
  if (remaining.length > 0) {
    throw new Error('Storage policy dump contains SQL outside the allowlisted policy statements.');
  }
  return sorted(records.map((record) => record.name));
}

export function validateStorageExcludedDataDump(dataDump) {
  const storageDml =
    /^\s*(?:COPY|INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:"storage"|storage)\s*\.\s*(?:"[a-z0-9_]+"|[a-z0-9_]+)/imu;
  if (storageDml.test(dataDump)) {
    throw new Error(
      'Database data dump contains Storage-managed rows that must be restored through the Storage API.',
    );
  }
  return true;
}

export function validateStoryOpsExcludedDataDump(dataDump) {
  validateStorageExcludedDataDump(dataDump);
  const cronDml =
    /^\s*(?:COPY|INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:"cron"|cron)\s*\.\s*(?:"[a-z0-9_]+"|[a-z0-9_]+)(?![a-z0-9_])/imu;
  if (cronDml.test(dataDump)) {
    throw new Error(
      'Database data dump contains pg_cron schedules or run history that must be reinitialized on restore.',
    );
  }
  const dispatchOriginTransientDml =
    /^\s*(?:COPY|INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:"private"|private)\s*\.\s*(?:"(?:dispatch_current_origin_ephemera|dispatch_current_origin_verifiers|dispatch_origin_purge_worker_health)"|(?:dispatch_current_origin_ephemera|dispatch_current_origin_verifiers|dispatch_origin_purge_worker_health))(?![a-z0-9_])/imu;
  if (dispatchOriginTransientDml.test(dataDump)) {
    throw new Error(
      'Database data dump contains transient dispatch-origin rows that must never be archived or restored.',
    );
  }
  const allowedSchemas = new Set(REQUIRED_STORYOPS_DATA_DUMP_SCHEMAS);
  const mutationLine =
    /^\s*(?:COPY|INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\b[^\r\n]*$/gimu;
  const qualifiedTarget =
    /^\s*(?:COPY|INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:"([^"]+)"|([a-z_][a-z0-9_$]*))\s*\.\s*(?:"([^"]+)"|([a-z_][a-z0-9_$]*))(?=\s|\(|;|$)/iu;
  for (const statement of dataDump.matchAll(mutationLine)) {
    const match = qualifiedTarget.exec(statement[0]);
    if (!match) {
      throw new Error(
        'Database data dump contains unqualified or ambiguous DML outside the exact auth/public/private schema allowlist.',
      );
    }
    const schema = match[1] || match[2];
    const table = match[3] || match[4];
    if (!allowedSchemas.has(schema)) {
      throw new Error(
        `Database data dump contains DML outside the exact auth/public/private schema allowlist: ${schema}.${table}.`,
      );
    }
    if (/^\s*TRUNCATE\b/iu.test(statement[0]) && /,/u.test(statement[0].slice(match[0].length))) {
      throw new Error(
        'Database data dump contains ambiguous multi-table TRUNCATE DML outside the exact auth/public/private schema allowlist.',
      );
    }
  }
  return true;
}
