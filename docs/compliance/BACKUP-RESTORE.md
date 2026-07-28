# Supabase backup and restore runbook

The scripts implement a Supabase-oriented logical database backup with optional
Storage object export, checksummed manifest, owner-only permissions, atomic
publish, credential redaction, dry-run mode, restore confirmation, non-empty
target guard, transactional SQL, and idempotent Storage retries.

Supabase’s official workflow uses separate roles, schema, and COPY-based data
dumps:
[Backup and Restore using the CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).
Supabase also states that database backups omit Storage object bytes:
[Database Backups](https://supabase.com/docs/guides/platform/backups).

## What is and is not covered

Covered:

- application database roles/schema/data produced by pinned Supabase CLI;
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

### Post-backup controls

1. Confirm the command exited zero and inspect manifest counts/source.
2. Validate that `roles.sql`, `schema.sql`, `data.sql`, and every declared
   Storage object exist with matching checksum.
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
npm run restore -- \
  --backup /absolute/path/to/storyops-backup \
  --execute \
  --local \
  --confirm-target 127.0.0.1:54322/postgres
```

The script queries the target first and rejects existing application tables.
`--allow-nonempty` is an escalation for a reviewed exceptional recovery; the
restore still does not issue `DROP` or `--clean` and may fail on conflicts.

If managed role statements conflict with a fresh target, first investigate the
specific Supabase CLI/platform version and permissions. `--skip-roles` is
available only for a reviewed restore where platform roles already exist; record
the exception and validate privileges afterward.

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
npm run restore -- \
  --backup /absolute/path/to/storyops-backup \
  --execute \
  --db-url "$STORYOPS_DATABASE_URL" \
  --allow-remote \
  --confirm-target 'TARGET-HOST:5432/postgres'
```

The restore passes password/host through PostgreSQL environment variables and
executes roles/schema/data in one `psql --single-transaction` operation with
`ON_ERROR_STOP=1`. It does not cut traffic over, change DNS, or delete the old
project.

### Storage restore

Use only when the manifest says Storage was included:

```bash
export SUPABASE_URL='https://NEW-PROJECT.supabase.co'
export SUPABASE_SERVICE_ROLE_KEY='...'
npm run restore -- \
  --backup /absolute/path/to/storyops-backup \
  --execute \
  --db-url "$STORYOPS_DATABASE_URL" \
  --allow-remote \
  --confirm-target 'TARGET-HOST:5432/postgres' \
  --restore-storage
```

The script creates missing buckets and uploads without overwrite. On retry, an
existing byte-identical object is a safe no-op; a different object stops the
restore. Overwrite requires both `--replace-storage` and the exact
`--confirm-storage-host NEW-PROJECT.supabase.co`. Review conflicts individually
before using that destructive option.

## Mandatory post-restore validation

- [ ] SQL transaction and optional Storage upload completed without ignored
      errors.
- [ ] Expected migrations/tables/functions/triggers/indexes/extensions exist.
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
