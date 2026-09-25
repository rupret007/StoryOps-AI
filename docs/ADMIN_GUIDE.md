# WashOps administrator guide

**Audience:** owner and designated dispatcher/operator  
**Status:** V1 sandbox operations plus production activation controls  
**Last reviewed:** 2026-07-29

The owner is accountable for business policy and every live commitment even
when an automation prepared it. The safest operating posture is simple:
providers remain sandboxed or disabled until their evidence is complete, and
uncertainty returns to the owner instead of being guessed.

Start each session with [current status](STATUS.md). Resolve source conflicts
using [the source-of-truth policy](SOURCE_OF_TRUTH.md). For a pristine live
company, follow the
[authenticated setup runbook](runbooks/LIVE_SETUP_RUNBOOK.md).

## First-time setup

1. Install Node `22.22.3` and Docker (the full verification uses a pinned Deno
   container), then run:

   ```bash
   npm run setup:app -- --verify
   npm run dev
   ```

2. Open `http://127.0.0.1:5173` and review the setup wizard. In sandbox mode it
   changes only synthetic IndexedDB state. In Supabase mode, a protected
   first-owner invitation may use it to create one setup-only company, first
   owner membership, inactive selected services, draft zero-valued price book/
   terms/retention records, eleven disabled integrations (including the
   separately gated Supabase Auth invitation provider), and
   `launchAuthorized=false`. It does not publish services, prices, terms, or
   authorize launch. The ordinary workspace remains closed while the company is
   `setup`; only the finite reviewed configuration/baseline sequence may
   activate it.
3. For local authenticated/RLS verification, start the local Supabase stack and
   set `VITE_STORYOPS_DATA_MODE=supabase` with the local public URL, public anon
   key, and seeded company UUID. The app will present magic-link sign-in and
   derive the role from the active membership. Never put the service-role key
   in a `VITE_` variable.
4. Review the DFW starter price book in Operations. Have a Texas tax
   professional and appropriate legal/business reviewer determine taxability,
   discounts, terms, deposit handling, and service descriptions before
   publishing a real price book.
5. Review the safety and launch checklists. Adopt actual manufacturer-, product-,
   site-, jurisdiction-, and insurance-specific SOPs. Never treat starter
   content as permission to perform work.
6. Keep every provider in sandbox. Add no secrets until the provider activation
   procedure is complete.

## Daily owner cadence

Before field work:

- read the owner briefing and confirm its source window/freshness;
- handle RED/BLOCKED safety, weather, scope, consent, payment, and provider
  items first;
- verify today’s address, scope, authorization, crew/equipment, route, current
  weather, access, materials/SDS, containment/disposal plan, and emergency
  contacts from authoritative records;
- review expiring approvals and reject anything whose exact payload, evidence,
  amount, recipient, or conditions changed; and
- reconcile unknown provider actions before retrying.

End of day:

- confirm visit checklists, actual time/material, before/after evidence,
  exceptions/incidents, and signatures;
- reconcile issued invoices and provider-confirmed payments;
- clear or assign failed automations/webhooks/outbox conflicts;
- update the current status if a release or launch gate changed; and
- ensure the next verified backup remains inside the approved RPO.

The detailed AI cadence is in [AI_OFFICE_RUNBOOK.md](runbooks/AI_OFFICE_RUNBOOK.md);
provider cadence is in
[INTEGRATION_RUNBOOK.md](runbooks/INTEGRATION_RUNBOOK.md).

## Roles and access

- **Owner:** business settings, memberships, price books/SOPs, integrations,
  approvals, payments, audit, and all operational records.
- **Dispatcher:** qualified operational work—customers/properties, estimates,
  jobs/dispatch, invoices, communications, incidents, and read-only approvals.
  The dispatcher cannot decide owner-only approval items or manage live
  credentials.
- **Technician:** assigned job/visit data and field execution, materials read,
  and incident reporting. Assignment scope matters in addition to role.
- **Customer:** own portal records only.

The UI role selector exists only in sandbox/E2E mode. In Supabase mode, the
browser uses Auth and `get_storyops_workspace`; it cannot select its role.
Membership and portal links must be created through an authenticated
owner/admin server boundary; never grant access by editing browser state or
trusting an email claim. The sole first-owner exception is
`complete_storyops_setup`: it requires protected Auth
`app_metadata.storyops_bootstrap_company_id` to exactly match the configured
company UUID. Browser state, email address, the public UUID, and user-editable
metadata are never authority.

## Company operational control

**Company control** is an owner-only company-wide kill switch in authenticated
Supabase mode. It is unavailable to dispatchers, technicians, customers,
service credentials, and a company still in `setup`. Do not use a company
profile/settings edit or direct SQL from an operator session to change
lifecycle state.

To pause:

1. make people and the site safe first; the app is not an emergency system;
2. open **Company control** from a currently server-verified owner session;
3. record a factual reason of 10–1,000 characters and type the exact displayed
   `PAUSE <company name>` confirmation;
4. submit once and retain the lifecycle receipt, request hash, server time, and
   audit event; and
5. refresh recovery state from a second authorized owner device where possible.

Pending offline packets never prevent pausing. They stay on the originating
device, cannot sync while paused, and are not copied into the lifecycle
request. The recovery page intentionally shows only packet kind, status, and
creation time, plus last server verification and any current recovery error.
Do not add payloads, entity/customer IDs, photo bytes, thumbnails, notes, or
signature data to screenshots, logs, or incident channels.

While paused, ordinary tenant writes, new provider-call or automation starts,
field finalization, and Storage writes fail closed. The scope-photo boundary
will not mint a fresh signed upload target, including from a replayed
reservation. A signed token issued before the pause is not retroactively
revoked; treat it as sensitive until its short expiry. It cannot be finalized
into company evidence while paused, and an expired unregistered reservation may
be processed by the trusted orphan-cleanup worker.

Do not disable reconciliation just because the company is paused. Signed
callbacks/provider retrieval for already accepted external work, bounded
failure bookkeeping, approved retention processing, and orphan cleanup remain
available so WashOps does not lose external truth or leave abandoned objects.
Do not use those narrow paths to start new customer work.

To reactivate:

1. identify and disposition the incident/cause, including accepted or unknown
   provider actions and every pending device packet;
2. from a server-verified owner session, enter the reason and exact
   `REACTIVATE <company name>` confirmation;
3. reconcile the returned receipt against the read-only lifecycle history;
4. require a successful full server workspace reload before operating; and
5. replay the original offline queue idempotently, resolving any stale version
   or authorization conflict instead of creating replacement commands.

The server accepts only `active → paused` and `paused → active` with an exact
expected state and canonical hashed request. Same-command/same-request replay
returns the original result; changed reuse or stale state conflicts.
Reactivation restores eligible operational writes only. It does not turn on
live providers, authorize customer contact, approve launch, release a payment
hold, or resolve the incident by itself.

When someone leaves:

1. disable/revoke their auth access and active membership;
2. remove sessions/tokens and provider access;
3. reassign jobs/approvals/incidents;
4. rotate shared secrets that person could access;
5. preserve audit/history; and
6. record actor, time, scope, and verifier.

## Price-book administration

A real quote may use only one active, effective, published price-book version.

Before publishing:

- verify service code/unit, included quantity, service/company minimum,
  attribute allowlist/multiplier, add-on, estimated cost/duration, taxability,
  exact non-overlapping five-digit ZIP-to-travel-zone mappings, deposit,
  automatic discount limit, and margin floor;
- record the travel-zone mapping reviewer, review time, and evidence reference;
- attach tax/legal/business review evidence;
- run fixed fixtures and boundary tests;
- compare the old/new totals on representative properties;
- set effective dates and rollback/next version; and
- approve the exact version.

Published versions are immutable. Correct an error by publishing a new version,
not editing history. Existing estimates/quotes retain their source version and
calculation snapshot.

Mileage bands are optional descriptive metadata; they never select a fee.
WashOps resolves a travel fee only from one exact reviewed ZIP mapping.
Unmapped or multiply mapped ZIPs block the estimate. After upgrading an
installation with a legacy active price book, check
`companies.settings.travelZoneRemediationRequired`. If true, review the ZIP
mappings in Company Configuration Studio, publish a new live configuration,
then publish a new operating baseline. Do not clear the flag manually; a
successfully activated price book with complete mapping evidence clears it
atomically.

Measurements need method, unit, source, confidence, observation time, and human
verification where required. Photo observations may inform scope but may not
silently become square/linear footage.

## Approval operation

Review the exact payload, not only the summary. Confirm:

- authenticated requester, company, run/action/tool, risk, policy version, and
  expiry;
- current source IDs and evidence freshness;
- exact recipient/provider target, amount, date/time, terms, price book/SOP,
  consent, availability, and unknowns;
- payload SHA-256 and whether a provider action might already have happened;
  and
- rollback/compensating action and accountable operator.

Approve once or reject. Any changed field requires a new request. Approval does
not bypass missing permission, injection detection, stale/unknown evidence,
unsafe conditions, or an absent tool/adapter.

Always require owner review for price exceptions/large discounts, refunds,
legal/safety messages, negative-review replies, campaign sends, vendor/bank
actions, destructive changes, and work outside approved price books/SOPs.
Regulatory filings, emergency response, chemical decisions, bank/vendor
execution, and other human-only work remain outside AI execution.

Use [the approval record template](templates/APPROVAL_RECORD.md) for external
evidence.

## Provider activation

Never put a secret in a `VITE_` variable, browser storage, screenshot, issue,
email, chat, log, or source file. Store live secrets only in the deployment
secret manager/server runtime.

For each provider independently:

1. keep mode `sandbox` or `disabled` and its separate live-enable switch
   `false`;
2. establish a separate provider sandbox/test account and least-privilege
   credential;
3. implement/verify the actual server adapter—an interface is not connectivity;
4. configure the canonical public webhook/OAuth URL and validate signatures
   over the provider-required raw/canonical request;
5. prove consent/opt-out/quiet-hours, rate limits, timeout/retry,
   idempotency/duplicate/conflict, delivery/payment retrieval, and
   reconciliation;
6. verify the health endpoint reports missing configuration without secret
   values;
7. complete legal/security/provider registration requirements;
8. add production secrets, set that provider’s mode to `live`, and set its
   separate live-enable switch to `true`; either switch alone remains disabled;
9. run one owner-approved, low-risk canary and reconcile provider/local/audit
   IDs; and
10. record rollback/kill switch and incident owner.

The authoritative per-provider boundary and required evidence is in
[PROVIDER-BOUNDARIES.md](compliance/PROVIDER-BOUNDARIES.md). V1 implements
server-side adapters for OpenAI, Twilio, HTTP email, Stripe, Google
Calendar/maps, NWS, VROOM, optional server-signed Supabase Storage targets, and
QuickBooks CSV. That is code availability, not launch evidence: no hosted
callback, real credential, account registration, or external canary has been
verified. Keep all optional providers sandboxed/disabled until the exact
activation checklist is signed. QuickBooks remains reviewable manual CSV
import; it does not post through OAuth.

Authenticated `VITE_STORYOPS_DATA_MODE=supabase` field work is separate from
optional provider activation. It requires the private `job-media` bucket,
assignment-scoped RLS, immutable upload/read-back, and the byte-verifying
`field-media-finalize` boundary. The
`SIGNED_STORAGE_TARGETS_MODE`/`SIGNED_STORAGE_TARGETS_LIVE_ENABLED` card covers
only optional server-issued targets and is not field readiness. Any core media
failure must remain visible and block completion.

The integration-health screen uses seeded optional-provider cards in sandbox
mode. In Supabase mode it invokes an authenticated Edge probe restricted to
owners and dispatchers, with a durable per-user hourly budget. It also labels
the core field-media plane separately: sandbox means zero Storage calls;
Supabase means mandatory and fail-closed. A configured or compiled adapter is
still not healthy until its active probe and canary are recorded.

## Consent and communications

- Store purpose-specific transactional/marketing consent with source, proof,
  timestamp, contact, and timezone.
- Use the exact current consent snapshot at send time; stale/unknown consent
  blocks the message.
- Persist opt-out before any later automation. Do not send marketing after
  withdrawal.
- Provider acceptance is not delivery. Reconcile callbacks/retrieval.
- Run `post-service-worker` only from a trusted scheduler using its independent
  `POST_SERVICE_WORKER_TOKEN`; never use the Supabase service-role key as a
  network bearer. The finite endpoint leases at most 25 due records per
  request, rechecks current consent/contact/suppression, prepares a deterministic
  routine template, and submits through the configured adapter. Schedule it at
  least every 15 minutes during approved contact hours.
- A `sandboxed` follow-up and `sandbox_recorded` provider status prove only
  local workflow execution. The linked communication remains `queued`, has no
  provider message ID, and must never be reported as sent or delivered.
- A live Twilio row in `submitted_unknown` / `submission_unknown` crossed the
  durable pre-submit boundary but lacks a safely completed local receipt. It is
  excluded from automatic claims. Do not resend it; reconcile the signed
  callback/provider account and preserve the exact SID if one exists.
- `post-service:<followup UUID>` is a WashOps correlation key, not a Twilio
  Message-create idempotency guarantee.
- Live post-service marketing email is disabled in V1 until a signed
  unsubscribe endpoint and durable suppression/bounce/complaint path pass
  legal and provider canaries. Sandbox email remains available.
- The live outbound boundary verifies that the snapshot is the latest record,
  matches the recipient and purpose, and is not suppressed; it then consumes
  durable company and contact rate budgets before submission.
- Web/chat/email lead events use timestamped HMAC and Twilio intake uses the
  request signature. Successful normalized intake persists the lead,
  communication thread/message, consent assertions, webhook claim, and
  idempotency receipt.
- Negative-review replies, legal/safety content, and campaign sends require
  review as defined by policy.
- Complete required TCPA/FCC/carrier/state/privacy and call-recording legal
  review before live SMS/voice/email.

## Field and offline operation

Before deliberately going offline, open the assigned visit and required
evidence while connected. On device:

- work only on the authenticated/assigned visit and approved scope;
- record actual—not estimated—checklist results, time, materials, evidence,
  notes, exceptions, and signature;
- stop for any safety-critical item, changed scope, unknown discharge path, or
  missing SOP/SDS;
- never clear site data or uninstall the PWA with a pending outbox; and
- do not repeat a customer/provider action to “make sure” it happened.

After reconnecting, wait for the queue to reconcile. Same command ID and
request hash replays the durable result; a changed payload is a conflict
requiring review. Supabase mode sends ordinary finite visit mutations through
`execute_storyops_command`, which rechecks authenticated role/assignment and
optimistic version. Media registration is deliberately excluded: the generic
command RPC rejects `media.register`, and the field-media finalizer independently
downloads, validates, and hashes the stored bytes before its service-only RPC
may register evidence. Live queue state is scoped to the signed-in user and
company and is purged on sign-out or identity mismatch. Media uploads are not
discarded when offline: original bytes, local SHA-256, stable UUID, upload,
finalization work, and signature dependencies remain in the scoped IndexedDB
packet. On replay, WashOps reads uploaded bytes back before the database may
register the matching Storage object. A completion request remains visibly
pending and the visit is not completed until those dependencies and the exact
completion RPC reconcile. Do not clear a failed packet; record the conflict and
have an owner/dispatcher resolve the authoritative server state. Hosted
device-loss, revoked-access, conflict, quota-exhaustion, and recovery canaries
remain manual YELLOW launch gates.

If the company is paused, do not clear or replace the queue. The owner may still
engage the kill switch when packets are pending; the device preserves them and
shows metadata-only diagnostics. Resume sync only after owner reactivation and
a successful full workspace reload. A packet rejected because its role,
assignment, expected version, or company facts changed remains a conflict for
review—not permission to replay it under a new identity.

## Invoices, payments, and accounting

- Issue only from completed, reviewed work and approved amounts.
- A Checkout redirect, receipt page, webhook acceptance, or customer statement
  does not prove payment.
- Reconcile amount, currency, invoice, customer, provider ID, state, settlement,
  refund/dispute, and observed time.
- Refunds always require exact-payload approval and provider reconciliation.
  V1’s `ai-approved-action` boundary permits only an authenticated owner and
  only `payments.refund`; it revalidates the persisted approval, current
  payment/refund eligibility, company, amount, provider result, and execution
  lease before consuming the approval exactly once. Ambiguous results remain
  pending reconciliation and retry with the same provider idempotency key.
- QuickBooks output is a checksummed CSV for owner review/manual import; it
  performs no bank/vendor mutation.

Use [the provider reconciliation template](templates/PROVIDER_RECONCILIATION.md).

## Backup and restore

Run a local logical backup:

```bash
npm run backup -- --local
```

Validate a backup/restore plan without mutation:

```bash
npm run restore -- \
  --backup /absolute/path/to/storyops-backup \
  --dry-run \
  --local
```

Backups are owner-readable but not encrypted. Production requires encrypted,
off-site, separately protected copies, legal-hold handling, monitoring, and
regular disposable-target restore drills. Browser IndexedDB data that never
synchronized is not included. Follow
[the backup/restore runbook](compliance/BACKUP-RESTORE.md).

## Incidents and stop-work

For injury, exposure, spill/discharge, property damage, privacy/consent issue,
payment uncertainty, unauthorized action, duplicate/conflicting provider
event, secret exposure, cross-company access, or missing evidence:

1. make people/site safe and use the reviewed emergency plan;
2. stop/disable the affected automation or provider without deleting evidence;
   when the impact is company-wide, have an owner with active membership engage
   **Company control** and record the exact pause receipt;
3. preserve original records, photos, raw provider IDs, logs, trace/approval/
   idempotency IDs, and timeline;
4. notify the accountable owner and required professional/authority;
5. reconcile external state read-only;
6. use
   [the incident playbook](incidents/AI_INTEGRATION_INCIDENT_PLAYBOOK.md) and
   [incident template](templates/INCIDENT_REPORT.md); and
7. reactivate/re-enable only after corrective-action tests, reconciliation,
   full workspace readback, and owner approval.

AI may organize supplied facts and draft reviewed communications. It may not
diagnose, direct emergency/chemical response, admit liability, contact a
regulator/insurer, or publish an incident statement.

## Retention, privacy, and launch

Use [the retention/privacy policy](compliance/DATA-RETENTION-AND-PRIVACY.md) to
set approved schedules and legal holds. Retention defaults in code/docs are
technical starting points, not legal conclusions.

No live launch is approved until every applicable hard gate and professional
sign-off in [the DFW launch checklist](launch/DFW-LAUNCH-CHECKLIST.md) is
complete. The
[field safety checklist](launch/EXTERIOR-CLEANING-SAFETY-CHECKLIST.md) is a
control framework, not a chemical recipe, disposal authorization, equipment
manual, rescue plan, or substitute for a qualified reviewer. The approved
retention schedule, production restore drill, and WashOps root-project
distribution license are separate manual YELLOW gates.
