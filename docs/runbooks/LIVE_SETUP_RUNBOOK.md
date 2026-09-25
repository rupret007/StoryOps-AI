# Authenticated live setup runbook

**Audience:** trusted Supabase administrator and the company owner  
**Status:** implemented onboarding boundary; hosted auth/RLS canary still required  
**Last reviewed:** 2026-07-30  
**Release evidence:** V1.1 final source-freeze verification and local release
commit pending

This runbook authorizes one signed-in owner to provision one WashOps company in
`setup` status. It does not authorize launch, publish pricing or terms, activate
services or providers, open the ordinary operational workspace, contact a
customer, or move money.

Until [`BUILD_REPORT.md`](../../BUILD_REPORT.md) records the exact frozen-source
verification, use this boundary only with the local synthetic stack. Earlier V1
counts, screenshots, hashes, backup artifacts, or commits do not authorize a
V1.1 hosted setup.

## Security boundary

The browser receives only the public Supabase URL, public anon key, and a random
company UUID. A new company can be created only when the authenticated user's
protected Supabase `app_metadata.storyops_bootstrap_company_id` exactly matches
that configured UUID.

- Set the claim only through a trusted Supabase administrative boundary.
- Never use `user_metadata`; users can edit it.
- Never place the service-role key, database password, or any other secret in a
  `VITE_` variable, browser, ticket, screenshot, or client log.
- A public company UUID is not authority. The server rejects an identity without
  the protected matching invitation.
- A customer-portal identity, an identity already scoped to another company, or
  an identity attempting to claim an existing company is rejected.

## Issue the one-company invitation

1. Generate a cryptographically random UUID for the new company. Record the
   intended owner, issuer, timestamp, and UUID in the administrative change
   record.
2. Configure the reviewed browser build with:

   ```text
   VITE_STORYOPS_DATA_MODE=supabase
   VITE_SUPABASE_URL=<public project URL>
   VITE_SUPABASE_ANON_KEY=<public anon key>
   VITE_STORYOPS_COMPANY_ID=<random company UUID>
   ```

3. Through the Supabase dashboard or a trusted server using the Supabase Admin
   API, create/invite the intended owner and set protected app metadata to:

   ```json
   {
     "storyops_bootstrap_company_id": "<the same random company UUID>"
   }
   ```

4. Confirm that the email belongs to the intended owner. Do not delegate the
   invitation to an AI agent or accept an owner-supplied JWT.
5. Have the owner sign in through the WashOps magic-link screen. A successful
   invitation yields `status: "required"` from
   `get_storyops_setup_state(company_uuid)`; it does not create a company yet.

Existing local seed users already have durable memberships and do not need this
bootstrap claim. Never use the local seed or its passwords in a hosted project.

## Complete and verify setup

1. In the wizard, enter the verified business/owner names, five-digit home ZIP,
   and currently offered services.
2. Review the acknowledgement. It describes the records that will be created;
   the screen does not claim they exist before confirmation.
3. Choose **Create setup workspace** once. The client derives a stable command
   UUID and SHA-256 request hash; the server replays only the exact same request
   and rejects a changed payload.
4. Retain the server receipt and `company.setup_completed` audit event.
5. Verify all of the following from an administrative read-only connection:

   - one company exists at the invited UUID with `status = 'setup'`;
   - the intended user has one active `owner` membership;
   - `setupWizardCompleted` is true and `launchAuthorized` is false;
   - all five supported service drafts exist and remain inactive, while
     `enabledServiceCodes` exactly matches the selected initial scope;
   - the price book, service terms, and retention policy are drafts requiring
     review, with no invented/published price;
   - every integration record expected by the frozen source is present and
     disabled, with the exact set/count recorded in final verification; and
   - the setup audit event and request ID match the retained receipt.

6. After verification, remove the bootstrap claim through the same trusted
   administrative boundary and require a fresh session. The durable membership,
   not a lingering invitation, is the ongoing authorization source.

At this point the company is still `setup`, not `active`. The owner may use only
the finite configuration draft/publication and operating-baseline commands
needed to complete reviewed activation. Caller-created settings, direct tenant
writes, ordinary workspace commands, and service credentials cannot forge that
temporary capability. The browser must not project the normal operational
workspace while the company remains `setup`.

Before live publication, register every configured material that requires an
SDS:

1. Obtain the manufacturer-issued PDF and record its source/reference. WashOps
   does not create mixing, application, PPE, disposal, emergency, or other
   chemical instructions.
2. In configuration, select the reviewed PDF to calculate its SHA-256, complete
   owner review, mark that exact evidence approved, and save the draft revision.
3. In **Private material & SDS registry**, enter the exact product,
   manufacturer, revision date, and bounded internal review reference, then
   select the same PDF.
4. Retain the registration receipt. The server reserves a private,
   content-addressed, write-once Storage path; the trusted Edge boundary
   downloads the bytes, verifies PDF signature/size/SHA-256, and finalizes an
   immutable document version. A browser checksum or source URL alone is never
   evidence.
5. Verify `material.sds_registration_prepared` and `material.sds_registered`
   audit evidence and confirm the registry reports the exact configuration
   revision/hash and document checksum. A missing, changed, or stale version
   blocks live configuration publication, baseline publication, field
   projection, and material usage.

Never overwrite a rejected upload path. Preserve the failure evidence and use a
new server-prepared version after the reservation expires or after reviewed
administrative cleanup.

Only after the owner publishes a live-reviewed configuration and the exact
operating baseline may the baseline transaction change the company to `active`
and materialize its published operating records. That activation still keeps
`launchAuthorized=false`, keeps optional providers disabled, and enables no
outbound customer contact. Preserve and verify the configuration and baseline
receipts before allowing operator access.

Provider activation is intentionally a second, non-circular phase:

1. Publish the first reviewed live configuration and operating baseline with
   every provider requested as disabled. This activates the internal company
   workspace only.
2. Run the authenticated deployment health probe. It records a secret-safe
   environment generation, mode, capabilities, health, and expiry; the browser
   cannot edit that evidence.
3. Enable one exact provider generation from **Integrations**. Enabling is an
   owner command distinct from deployment configuration and invalidates any
   prior launch authority.
4. Change that provider's Studio intent to live, republish the live
   configuration, and publish a new matching operating baseline. Repeat one
   provider at a time.
5. Execute and retain the required real provider canaries, private field-media
   roundtrip, scheduling proof, and isolated restore proof through the trusted
   release-evidence procedure. An owner attestation is never promoted to
   trusted system proof.
6. Only after every legal/operational review and exact proof is current may the
   owner enter an audited reference and request controlled-launch
   authorization. The server—not the button—decides whether the exact bindings
   qualify.

A provider fingerprint/mode/capability change disables that activation and
invalidates launch. Health expiry blocks invocation without rewriting the
generation. Provider disable and launch revoke remain available during company
recovery; reactivation never restores them implicitly.

## Configure the four private workers

Before requesting provider launch, set the immutable running
`STORYOPS_RELEASE_ID`, configure four independent 32-byte-or-longer worker
tokens, and deploy one monitored scheduler invocation per active company. The
reviewed request bodies are:

```json
{
  "companyId": "<active-company-uuid>",
  "trigger": "scheduled",
  "batchSize": 10,
  "leaseSeconds": 90
}
```

Send that body to `post-service-worker` every 900 seconds.

```json
{
  "companyId": "<active-company-uuid>",
  "trigger": "scheduled",
  "batchSize": 25,
  "leaseSeconds": 90
}
```

Send that body to `transactional-outbound-worker` every 60 seconds.

```json
{
  "companyId": "<active-company-uuid>",
  "batchSize": 10,
  "leaseSeconds": 90
}
```

Send that body to `scheduling-reconciliation` every 120 seconds.

```json
{
  "companyId": "<active-company-uuid>",
  "trigger": "scheduled",
  "limit": 50
}
```

Send that body to `scope-photo-cleanup` every 900 seconds. Set each matching
`*_SCHEDULE_INTERVAL_SECONDS` value to the reviewed recurrence. A manual
recovery request also requires the exact `companyId`. Migration
`20260728660000` retires the global/no-company claim signatures; do not retain
an older scheduler payload. Alert on every non-2xx and missed recurrence.

After deployment, run authenticated Integration Health to establish the
reviewed configuration/release generation, then require a successful scheduled
heartbeat from all four workers. Missing, failed, stale, cross-release,
cross-configuration, unavailable-queue, or submission-unknown evidence blocks
launch. Disabled/manual workers remain safe but are not live-ready.

After baseline activation, ordinary owner updates still cannot alter company
lifecycle status or server-managed setup/launch evidence keys. Later
`active ↔ paused` changes use the separate owner-only lifecycle control; they
cannot be performed through company profile/settings, generic commands, or
direct browser DML. Any other lifecycle correction requires a reviewed finite
administrative command or migration with attached approval evidence.

Setup also does not weaken downstream V1.1 controls. Quote acceptance still
requires a typed signer and affirmative acknowledgement of the exact quote,
terms, and total. The owner audit view remains bounded and redacted. Checkout
Session and PaymentIntent identities remain distinct; retired checkout attempts,
late-success quarantine, payment-allocation holds, and exact owner resolution
remain server-enforced regardless of setup status.

## Failure and recovery

- If the RPC is rejected, the UI remains on an unconfirmed review screen. Do not
  describe the workspace as ready.
- An exact retry returns the original idempotent setup receipt and must not
  duplicate company artifacts or audit events.
- A different request using the same stable command is a conflict. Stop and
  review the original receipt and company state.
- A partially populated or non-pristine setup company fails closed. Do not
  delete or overwrite it merely to retry; open an incident and use a reviewed
  corrective migration.
- If setup completes but the full workspace is unavailable, first confirm the
  company is still `setup`. This is expected until reviewed baseline activation;
  do not “fix” it by changing status or settings directly.
- If the invitation went to the wrong identity, revoke its sessions and access,
  clear the protected claim, preserve audit evidence, rotate any exposed
  credentials, and follow the integration/security incident playbook.

Before real operations, complete the hosted authentication, cross-role RLS,
private Storage, backup/restore, observability, rollback, provider, and DFW
professional-review gates in the release status and launch checklist.

Official-source links in the DFW and safety checklists have been reviewed, but
applicability has not been verified. Those checklists are engineering aids, not
legal, tax, environmental, insurance, communications, privacy, or safety
approval.

No push, deployment, provider activation, purchase, customer contact, or secret
exposure is authorized by this runbook.
