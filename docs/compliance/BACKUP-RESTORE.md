# Supabase backup and restore runbook

The scripts implement a Supabase-oriented logical database backup with optional
Storage object export, a separately retained manifest digest, owner-only
permissions, atomic directory publish, credential redaction, dry-run mode,
restore confirmation, authenticated read-once staging, a non-empty target
guard, transactional SQL, and idempotent Storage retries.

Supabase’s official workflow uses separate roles, schema, and COPY-based data
dumps:
[Backup and Restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
Supabase also states that database backups omit Storage object bytes:
[Database Backups](https://supabase.com/docs/guides/platform/backups).

## What is and is not covered

Covered by the `storyops-supabase-logical-v2` format:

- application database roles/schema/data produced by pinned Supabase CLI;
- managed Auth rows retained by the data dump;
- a strictly scoped, checksummed `storage-policies.sql` containing only the
  current StoryOps policies on managed Storage tables;
- checksums, byte counts, source target metadata, CLI version;
- optional bucket configuration and every Storage object byte/checksum;
- safe restore to local or a separately confirmed remote target.

Not a complete Supabase project snapshot:

- Edge Function source/deployments and function secrets;
- provider/OAuth grants and secret-manager values;
- Dashboard project settings, custom domains, webhooks, Realtime publication
  choices, network restrictions, or platform billing;
- encryption root keys, custom role passwords, or every managed `auth`/`storage`
  schema customization;
- external email/SMS/Stripe/Calendar/QuickBooks records;
- browser-only IndexedDB data that has not synchronized.

Source control, an environment inventory, provider exports/receipts, and the
platform’s approved recovery features remain necessary. Do not describe a
successful logical dump as a complete disaster-recovery backup.

## Backup

Dry run—no network, database, or filesystem changes:

```bash
npm run backup -- --dry-run --local
```

Executable local database backup:

```bash
npm run backup -- --local
```

Hosted database backup (keep the URL out of shell history):

```bash
export STORYOPS_DATABASE_URL='postgresql://...'
npm run backup -- --label production-daily
unset STORYOPS_DATABASE_URL
```

Database plus hosted Storage objects:

```bash
export STORYOPS_DATABASE_URL='postgresql://...'
export SUPABASE_URL='https://PROJECT.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='...'
npm run backup -- --include-storage --label production-daily
unset STORYOPS_DATABASE_URL SUPABASE_SERVICE_ROLE_KEY
```

The service-role key must be a short-lived/rotated operations secret where
possible, used only on a trusted dedicated runner. It is never written to the
manifest. The Supabase CLI accepts the database URL as a command argument, so on
shared hosts another privileged process may observe it while the dump runs;
production backups belong on an isolated trusted runner with a dedicated
least-privilege credential.

The script creates a hidden temporary directory, validates non-empty dump files,
exports Storage if requested, calculates SHA-256, writes `manifest.json`, and
atomically renames to the target. It never overwrites an existing directory and
removes only its own generated temporary directory after failure.

On success it prints `Manifest SHA-256 (retain in an independent trusted
location): …`. Capture that exact 64-character digest in an access-controlled
operations log, password manager, signed change record, or other trusted system
that is separate from the backup directory and its storage account. The digest
is not a secret, but its integrity is the restore authenticity boundary. Do not
place the only copy inside the backup, and never regenerate it from a received
or potentially modified archive immediately before restore.

An executable recovery-grade backup also requires `psql`. It records the source
Postgres system identifier and server observation time. The four checksummed
database artifacts are `roles.sql`, `schema.sql`, `storage-policies.sql`, and
`data.sql`. Its schema allowlist is exactly `auth`, `public`, and `private`;
`storage` and `cron` are therefore excluded. This omits Storage buckets,
objects, multipart state, analytics/vector metadata, Storage migrations, and
pg_cron state because those managed rows cannot safely be restored as ordinary
application data. Managed Auth data remains in `data.sql`.

The dump also explicitly excludes these three private, transient
dispatch-origin tables:

- `private.dispatch_current_origin_ephemera`;
- `private.dispatch_current_origin_verifiers`;
- `private.dispatch_origin_purge_worker_health`.

The ordinary schema dump excludes Supabase’s managed Storage schema, so the
script separately extracts only the exact release application policies. Restore
applies those policies after the application schema; the Storage API then
recreates buckets and object bytes when Storage export was requested. The
source backup is rejected unless the `service_role` catalog check reports zero
DML and related table-data privileges (`SELECT`, `INSERT`, `UPDATE`, `DELETE`,
`TRUNCATE`, `REFERENCES`, or `TRIGGER`) on every `public` base or partitioned
table.

`npm run test:supabase -- --reset` exercises real Supabase CLI schema and data
artifacts against the rebuilt local release. It validates the schema sentinels,
the exact schema allowlist and transient-table exclusions, retained Auth and
application rows, and the resulting data artifact before live recovery proof is
accepted.

### Cross-service consistency

A database dump plus Storage export is **not an atomic cross-service snapshot**.
The manifest records database dump start/end, source server observation,
estimated table counts, Storage export start/end, bucket/object counts, and
explicitly marks cross-service atomicity false. For a production recovery point:

1. use a reviewed maintenance/quiescence window that stops database/media
   mutations while both exports run; or
2. enforce immutable, content-addressed object paths and reconcile every
   `media_assets`/SDS record against the retained object manifest and source
   timestamps before declaring the backup usable.

Record the chosen method in the change/backup log. A zero-exit backup without
that consistency control is an unverified export, not a production recovery
point.

### Post-backup controls

1. Confirm the command exited zero, inspect manifest counts/source, and copy the
   printed manifest SHA-256 into a separately controlled trusted record.
2. Validate that `roles.sql`, `schema.sql`, `storage-policies.sql`, `data.sql`,
   and every declared Storage object exist with matching checksum.
3. Encrypt the directory before off-site transfer using the company-approved
   backup system/key. The script’s owner-only permissions are not encryption.
4. Store encrypted copies in a separate account/failure domain with MFA and
   immutability/versioning.
5. Record backup ID/path, manifest hash, environment, operator/run ID, database
   and Storage counts, encryption destination, retention class, and result.
6. Alert if the last verified backup exceeds the approved RPO.

Do not automate deletion until the approved retention policy, off-site copy
verification, legal holds, and at least one successful newer restore are checked.

## Restore rehearsal

Use a disposable local/fresh target. Never start by restoring over production.

Validate manifest/checksums and print the plan:

```bash
npm run restore -- \
  --backup /absolute/path/to/storyops-backup \
  --dry-run \
  --local
```

Execute against the local Supabase default:

```bash
export STORYOPS_BACKUP_MANIFEST_SHA256='LOWERCASE-64-HEX-DIGEST-FROM-SEPARATE-TRUSTED-RECORD'
npm run restore -- \
  --backup /absolute/path/to/storyops-backup \
  --execute \
  --local \
  --confirm-target 127.0.0.1:54322/postgres
unset STORYOPS_BACKUP_MANIFEST_SHA256
```

Every executable restore requires either
`STORYOPS_BACKUP_MANIFEST_SHA256` or
`--expected-manifest-sha256`. Retrieve that value from the independently
retained backup record. Do **not** run `sha256sum manifest.json` on the received
archive and use that result as the expected value: an attacker who replaced the
archive can replace both its files and its self-checksums.

Before querying or mutating the target, restore opens the manifest and every
declared database/Storage file without following symlinks, verifies the trusted
manifest digest plus each declared size/checksum, rejects psql meta-commands,
and writes the authenticated bytes once into a new owner-only temporary staging
directory. `psql` and Storage upload read only those staged paths. The source
archive is never reopened for execution, so replacing it after validation
cannot change restored bytes. The private staging directory is removed on
success or failure.

The script queries the target first and rejects existing application tables.
`--allow-nonempty` is an escalation for a reviewed exceptional recovery; the
restore still does not issue `DROP` or `--clean` and may fail on conflicts.

If managed role statements conflict with a fresh target, first investigate the
specific Supabase CLI/platform version and permissions. `--skip-roles` is
available only for a reviewed restore where platform roles already exist; record
the exception and validate privileges afterward.

### Signed isolated-restore evidence for pilot authorization

This is a stricter mode than an ordinary rehearsal. It can emit an
authorization-grade input only after an actual restore to an explicitly selected,
fresh, separately running loopback target. Start the dedicated migration-free
target on a dedicated Docker bridge whose published-port default is loopback.
The network inspection is mandatory; an API URL containing `127.0.0.1` does
not prove how Docker published the port:

```bash
docker network inspect storyops-restore-loopback >/dev/null 2>&1 || \
  docker network create \
    --driver bridge \
    --opt com.docker.network.bridge.host_binding_ipv4=127.0.0.1 \
    storyops-restore-loopback
docker network inspect \
  --format '{{json .}}' \
  storyops-restore-loopback | \
  jq -e '
    .Driver == "bridge" and
    .Options["com.docker.network.bridge.host_binding_ipv4"] == "127.0.0.1"
  '
npx --yes supabase@2.110.0 start \
  --workdir infra/restore-proof \
  --network-id storyops-restore-loopback

target_container_ids="$(
  docker ps \
    --filter label=com.supabase.cli.project=storyops-restore-proof \
    --format '{{.ID}}'
)"
test -n "$target_container_ids"
unsafe_target_binding_count="$(
  docker inspect \
    --format '{{json .NetworkSettings.Ports}}' \
    $target_container_ids | \
  jq -s '[
    .[] | to_entries[] | .value[]? |
    select(.HostIp != "127.0.0.1" and .HostIp != "::1")
  ] | length'
)"
test "$unsafe_target_binding_count" = 0
```

Capture `supabase status --workdir infra/restore-proof -o env` into a private
shell variable and parse only `API_URL` plus `SERVICE_ROLE_KEY`/`SECRET_KEY`;
never print or log the status blob. Unset the blob and target key immediately
after the drill. The CLI status output contains credentials even for a local
synthetic stack.

Create the source backup with Storage bytes during a quiesced/reconciled
recovery window:

```bash
export SUPABASE_URL='http://127.0.0.1:54321'
export SUPABASE_SERVICE_ROLE_KEY='SOURCE-LOCAL-SERVICE-ROLE-KEY'
npm run backup -- \
  --db-url 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
  --include-storage \
  --label isolated-restore-source
unset SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
```

Then restore with the dedicated target URL/key returned by its status command.
Do not use `--local` for signed evidence:

```bash
export STORYOPS_BACKUP_MANIFEST_SHA256='LOWERCASE-64-HEX-DIGEST-FROM-SEPARATE-TRUSTED-RECORD'
export PILOT_RESTORE_PROOF_HMAC_SECRET='INDEPENDENT-RANDOM-VALUE-AT-LEAST-32-BYTES'
export SUPABASE_URL='http://127.0.0.1:55321'
export SUPABASE_SERVICE_ROLE_KEY='DEDICATED-TARGET-SERVICE-ROLE-KEY'
npm run restore -- \
  --backup /absolute/path/to/storyops-backup \
  --execute \
  --db-url 'postgresql://postgres:postgres@127.0.0.1:55322/postgres' \
  --confirm-target 127.0.0.1:55322/postgres \
  --restore-storage \
  --pilot-evidence-out /absolute/private/path/restore-proof.json \
  --pilot-isolation-id storyops-restore-proof-55322 \
  --pilot-evidence-reference restore-drill-20260730
unset STORYOPS_BACKUP_MANIFEST_SHA256 PILOT_RESTORE_PROOF_HMAC_SECRET
unset SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
```

Configure the same dedicated secret in the deployed `trusted-pilot-proof` Edge
secret store only when that verifier is intentionally activated. The producer
requires at least 32 bytes and rejects reuse of configured database,
service-role, JWT, provider, webhook, or cleanup secrets. Keep it out of command
arguments, shell history, source control, browser variables, backup manifests,
and the evidence file.

The proof producer fails closed unless all of these are true:

- `--execute`, an explicit loopback `--db-url`, and `--restore-storage` are
  present; `--local` is rejected;
- the database host is `127.0.0.1`, `localhost`, or `::1`, the exact target
  confirmation matches, and the pre-restore application-table count is zero;
- the target endpoint differs from the source endpoint and the target Postgres
  system identifier differs from the trusted identifier in the source manifest;
- the explicit target Storage host differs from the source Storage host;
- neither `--allow-remote`, `--allow-nonempty`, `--skip-roles`,
  `--replace-storage`, nor `--allow-storage-policy-drift` is present;
- the V2 backup declares Storage-managed data exclusion, contains the exact
  release Storage policy artifact, includes Storage, and contains at least one
  object byte;
- the source manifest and schema fingerprints prove the exact current release
  migration `20260728660000` and its complete migration inventory, and record
  zero `service_role` DML and related table-data privileges on `public` base
  tables;
- the restored target contains exactly one active company, the launch/verifier
  tables and function signatures, enabled/forced RLS on critical tenant tables,
  immutable setup-receipt authority, canary quarantine/retirement guards, and
  one unresolved-email identity-invitation authority;
- the restored-target catalog independently reports zero `service_role` DML and
  related table-data privileges on `public` base tables;
- the exact-origin and verifier tables are private `UNLOGGED` relations with
  zero restored rows, exact restricted ACLs, and a recent successful
  scheduler-owned purge run; direct bootstrap execution is not health proof;
- `storage.objects` has RLS, the private `job-media` bucket retains its 25 MiB
  limit and allowlisted MIME types, its select/insert policies exist, and its
  retired update policy remains absent;
- a fresh target database dump passes all release schema sentinels; and
- every newly uploaded or already-present target object is freshly downloaded
  and matches its manifest byte length and SHA-256.

Only after those checks does the script obtain the target database server’s
current completion time, generate independent restore and request UUIDs, hash
the exact source manifest and restored target dump, and HMAC the entire strict
request envelope with the versioned domain separator. The signed V2 evidence
binds both database system identifiers, both Storage hosts, and the canonical
verified Storage object count, total bytes, and fingerprint. Object order cannot
change that fingerprint; any identity, path, length, or checksum change does.
Changing the company, command, expiry, or any restore fact invalidates the
signature. The JSON artifact is created once with mode `0600`; an existing path
is never overwritten. Temporary target-dump bytes are removed after hashing.

Exact departure coordinates are excluded from logical backups and the
`UNLOGGED` tables are empty after crash/recovery. This is deliberate
fail-closed behavior, not a cryptographic-erasure guarantee for local MVCC
remnants or infrastructure host snapshots. Review provider snapshot retention
and route-provider coordinate handling with privacy/legal counsel before live
activation.

The script does **not** POST the artifact, call a customer/provider, authorize a
pilot, or perform a cutover. An authenticated owner must inspect the artifact,
transfer it through the approved private operations channel, and manually submit
its exact `request` plus named signature header to the deployed trusted verifier.
The verifier reserves the request command before consuming it and derives the
durable proof from that immutable run.

This artifact proves a bounded isolated logical-database and declared Storage
object-byte restore. It does not by itself prove cross-service source
consistency, off-site encryption/retention, managed Auth/project settings,
deployed Edge Functions, provider readiness, customer-data reconciliation, or
production cutover safety. Complete every mandatory validation below.

After retaining the approved evidence, stop only the dedicated target:

```bash
npx --yes supabase@2.110.0 stop --workdir infra/restore-proof --no-backup
```

### V1.1 local rehearsal record

On 2026-07-31 UTC, implementation commit
`83950180d63e3455fa2047cd838ba5a2df8d9491` completed the executable isolated
rehearsal `restore-drill-20260731T025435Z`. The independently retained manifest
digest was
`b51e0b03891e5e66cb8a31db7dfcb53b47752d48701c0fbc9fdaabcfcfae2490`.
The source and target each proved all 67 migrations through
`20260728660000`; the migration-set fingerprint was
`98979fde9f841c360d1729ae8312f7f1c332175b51018633533baba9f3c1d894`.
The restore verified three private Storage objects totaling 204 bytes with
fingerprint
`2d7211ff109bd741427ecc7bd9431c6326dd0b48f7fa24a518823a54399e0ea7`.

The target used distinct database and Storage identities on loopback-only ports.
The generated V2 evidence file was owner-only (`0600`), its complete request
HMAC was independently recomputed successfully with the ephemeral local secret,
and the dedicated target containers/network were removed after verification.
No artifact was submitted, no cutover occurred, and this local rehearsal does
not close the off-site encryption, managed-platform reconstruction, hosted
canary, RPO/RTO, or production recovery gates.

## Remote restore

Create a fresh Supabase project/branch appropriate for recovery and align its
Postgres/platform versions, extensions, and settings. Then:

```bash
export STORYOPS_DATABASE_URL='postgresql://NEW-TARGET...'
npm run restore -- \
  --backup /absolute/path/to/storyops-backup \
  --dry-run \
  --db-url "$STORYOPS_DATABASE_URL"
```

After review, execute with both exact confirmation and remote authorization:

```bash
export STORYOPS_BACKUP_MANIFEST_SHA256='LOWERCASE-64-HEX-DIGEST-FROM-SEPARATE-TRUSTED-RECORD'
npm run restore -- \
  --backup /absolute/path/to/storyops-backup \
  --execute \
  --db-url "$STORYOPS_DATABASE_URL" \
  --allow-remote \
  --confirm-target 'TARGET-HOST:5432/postgres'
unset STORYOPS_BACKUP_MANIFEST_SHA256
```

The restore passes password/host through PostgreSQL environment variables and
executes roles, application schema, scoped Storage policies, and data in one
`psql --single-transaction` operation with `ON_ERROR_STOP=1`. It does not cut
traffic over, change DNS, or delete the old project.

### Storage restore

Use only when the manifest says Storage was included:

```bash
export SUPABASE_URL='https://NEW-PROJECT.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='...'
export STORYOPS_BACKUP_MANIFEST_SHA256='LOWERCASE-64-HEX-DIGEST-FROM-SEPARATE-TRUSTED-RECORD'
npm run restore -- \
  --backup /absolute/path/to/storyops-backup \
  --execute \
  --db-url "$STORYOPS_DATABASE_URL" \
  --allow-remote \
  --confirm-target 'TARGET-HOST:5432/postgres' \
  --restore-storage
unset STORYOPS_BACKUP_MANIFEST_SHA256
```

The script creates missing buckets and uploads without overwrite. Every provider
success is downloaded again and checked for exact length and SHA-256. On retry,
an existing byte-identical object is a safe no-op only after the same fresh
readback; a different or unreadable object stops the restore. Overwrite requires
both `--replace-storage` and the exact
`--confirm-storage-host NEW-PROJECT.supabase.co`. Review conflicts individually
before using that destructive option.

## Mandatory post-restore validation

- [ ] SQL transaction and optional Storage upload completed without ignored
      errors.
- [ ] Expected migrations/tables/functions/triggers/indexes/extensions exist.
- [ ] Source evidence and the restored-target catalog each report zero
      `service_role` DML and related table-data privileges on `public` base or
      partitioned tables.
- [ ] RLS is enabled and owner/dispatcher/technician/customer portal
      cross-access tests pass.
- [ ] Auth/OAuth settings, redirect URLs, email templates, custom role
      passwords, Realtime publications, webhooks, and Edge Functions are recreated
      from reviewed configuration.
- [ ] Bucket privacy/RLS/size and MIME policies, object counts/checksums, signed
      URL expiry, and representative photos/documents pass.
- [ ] Customer/property/quote/job/invoice/payment/consent/approval/audit counts
      reconcile to the backup evidence.
- [ ] Payment/delivery/calendar states reconcile read-only with live providers;
      no message, refund, booking, or bank action is triggered.
- [ ] Deterministic estimate fixtures match price-book versions and decimal
      totals.
- [ ] Offline clients are quarantined/reset or reconciled so stale queues cannot
      replay into the recovered environment.
- [ ] A read-only owner and customer-portal smoke test passes.
- [ ] Security reviewer approves; owner explicitly authorizes any cutover.
- [ ] Disposable rehearsal target and temporary credentials are removed through
      the approved provider workflow after evidence/holds are satisfied.

Record actual RPO/RTO, operator, backup/target IDs, manifest hash, deviations,
validation evidence, and incident/change reference. A restore is not complete
until business and security validation passes.
