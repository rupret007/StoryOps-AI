# StoryOps AI current status

**Updated:** 2026-07-30  
**Branch:** `codex/exterior-services-pilot-v1.1`  
**Phase:** V1.1 source hardening; final source-freeze verification pending  
**Overall verdict:** **YELLOW — sandbox/operator rehearsal only; live customer
operations are not authorized**  
**Owner:** company owner  
**Technical owner:** principal engineer

This file states the current operating posture. Exact command results,
screenshots, hashes, backup evidence, and commit provenance belong in
[`BUILD_REPORT.md`](../BUILD_REPORT.md) after final source-freeze verification.
Durable history belongs in Git and the application audit/incident stores.

## Executive status

StoryOps AI V1.1 implements a single-company service-business kernel and one
exterior-cleaning industry pack. The pack covers pressure/soft washing,
gutter/downspout cleaning, roof washing, exterior window cleaning, and related
add-ons. The kernel covers CRM/property records, deterministic pricing,
approvals, quote/portal, dispatch, offline field work, billing truth, AI
governance, integrations, audit, incidents, and recurring follow-up.

Current source boundaries include:

- quote acceptance with a typed signer and affirmative acknowledgement of the
  exact quote version, terms version, and total, persisted as append-only
  server evidence;
- an owner-only bounded, paginated, redacted audit metadata feed that does not
  expose raw payloads or actor IDs and is not represented as backup/integrity
  proof;
- distinct Stripe Checkout Session (`cs_*`) and PaymentIntent (`pi_*`)
  identities, retirement of failed/expired checkout attempts, and quarantine
  of a late success from a retired attempt;
- payment-allocation conflicts and collection holds whenever verified funds
  cannot be safely applied;
- an owner-only exact resolver for an approved conflict only when the verified
  amount still equals the current invoice balance and all server versions
  remain current; and
- scoped IndexedDB offline packets whose command/media identities, hashes,
  dependencies, and server reconciliation prevent optimistic completion; and
- an owner-only finite company lifecycle command and recovery projection:
  `setup` remains closed until baseline activation, `paused` blocks new
  operational/provider work, and `active` resumes only after exact server
  readback. Pending device packets are preserved across the pause.

The source also contains guarded setup, authoritative estimating,
quote-to-invoice transitions, field-media finalization, normalized ingress,
provider webhook reconciliation, approved refunds, post-service outbound, and
AI Office specialists. AI may draft, classify, summarize, and call
least-privilege tools, but it may not invent measurements, prices,
availability, payment state, regulations, or chemical/safety instructions.

Final release evidence is not yet frozen. No current test count, migration
count, screenshot set, backup fingerprint, image hash, proof timestamp, or
release commit is asserted in this status file.

## Readiness matrix

| Area                            | Current source posture                                                                                                                                                                         | Live boundary                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Exterior-services product slice | Implemented for sandbox/operator rehearsal; final release suite pending                                                                                                                        | Operator validates every active service, formula, minimum, duration, exclusion, package, travel ZIP, tax, deposit, and margin rule |
| Deterministic estimating        | Decimal/versioned rule boundary implemented; final source-freeze proof pending                                                                                                                 | Hosted authoritative-data canary and operator/legal/tax review                                                                     |
| Quote and customer portal       | Published-quote projection plus exact typed/affirmative acceptance boundary implemented                                                                                                        | Hosted customer isolation, expiry/replay, terms, accessibility, and delivery canary                                                |
| Owner audit view                | Bounded paginated redacted metadata feed implemented                                                                                                                                           | Hosted authorization/export/retention review; never treat it as backup or cryptographic integrity proof                            |
| Identity/RBAC/tenant isolation  | Auth/RLS/RPC contracts implemented                                                                                                                                                             | Hosted cross-role and cross-company canary, invitation/offboarding/session procedure                                               |
| First-company setup             | Protected invitation and guarded one-company setup boundary implemented; setup-only workspace remains operationally closed until reviewed baseline activation                                  | Hosted admin/Auth canary; generated artifacts remain draft/inactive/disabled and setup alone is never launch authority             |
| Company pause/recovery          | Owner-only finite active/paused control, immutable receipt/audit history, active-company mutation/provider gate, and minimal read-only recovery implemented                                    | Hosted concurrency, already-issued-token expiry, provider reconciliation, multi-device queue, alerting, and incident rehearsal     |
| Offline field workflow          | Scoped command/media replay and fail-closed completion implemented; pending packets survive pause and expose metadata-only recovery diagnostics                                                | Hosted device-loss, quota, conflict, Storage, recovery, pause/reactivation, and update/rollback canary                             |
| AI Office                       | Guarded specialists, typed tools, approvals, budgets, injection defenses, and redacted traces implemented                                                                                      | Model/privacy review, staged eval/canary, monitoring, kill switch, and incident owner; no scheduler is claimed configured          |
| Lead intake and communications  | Normalization, consent/opt-out, signatures, idempotency, ambiguity, and reconciliation boundaries implemented                                                                                  | Owned identities, approved language, public callback and delivery/STOP/bounce/complaint canaries                                   |
| Stripe billing                  | Checkout/invoice/refund, `cs_*`/`pi_*` separation, attempt retirement, allocation quarantine, holds, and exact resolution implemented                                                          | Account/tax review plus signed webhook, replacement/late-success, amount, idempotency, and reconciliation canaries                 |
| Calendar/maps/weather/routing   | Guarded provider interfaces and durable evidence contracts implemented                                                                                                                         | Reviewed credentials/endpoints/quotas and fresh provider canaries                                                                  |
| Provider/launch authority       | Trusted environment generations, finite owner activation/disable, append-only launch authorization/revocation, dynamic health checks, and live-start/database booking gates implemented        | Hosted deployment probes, real capability canaries, trusted field-media/restore proofs, and owner launch rehearsal                 |
| Photo-assisted scope            | Bounded evidence/unknown contracts and private Storage workflows implemented                                                                                                                   | Hosted media/privacy/content process, quota/lifecycle, signed-link expiry, and representative-media canary                         |
| Core field media                | Private Storage/RLS/Edge finalization boundary implemented                                                                                                                                     | Hosted Auth/device-loss/quota/tamper/recovery proof                                                                                |
| Customer photo upload           | Authenticated customer/staff requests use bounded private signed uploads, exact byte/hash finalization, tenant/customer/asset binding, retention state, and orphan cleanup                     | Hosted abuse/quota/content controls, cleanup scheduling/alerting, customer isolation, and representative upload/recovery canary    |
| Materials and SDS               | Exact configuration-bound PDF checksum workflow, private write-once upload, server byte/PDF/SHA-256 attestation, immutable document versions, and publication/baseline/field gates implemented | Adopted manufacturer documents/SOPs, qualified review, hosted private-Storage/tamper/offline-device canary, retention/legal hold   |
| QuickBooks                      | Formula-safe checksummed export boundary implemented                                                                                                                                           | Accountant mapping/import acceptance; no live ledger mutation                                                                      |
| Backup/restore                  | Recovery tooling and V1.1 object contract present                                                                                                                                              | Final local source-freeze artifact pending; hosted encryption, off-site retention, isolated restore drill, RPO/RTO remain open     |
| Observability                   | Runtime health, logs, traces, incidents, and runbooks present                                                                                                                                  | Production collector, dashboards, alerts, paging, on-call, and rollback evidence                                                   |
| DFW launch/compliance           | Official-source engineering checklists present                                                                                                                                                 | Professional and jurisdiction-specific legal/tax/insurance/environmental/safety/privacy/communications sign-offs                   |
| Distribution license            | Upstream notices and third-party inventory preserved                                                                                                                                           | Select and record StoryOps AI's root license before distribution                                                                   |
| Release evidence                | **PENDING**                                                                                                                                                                                    | Freeze source, run every required command, capture fresh screenshots/proof, complete independent audit, and create local commit    |
| Deployment                      | Not performed                                                                                                                                                                                  | Reviewed hosting, TLS, secret manager, access controls, monitoring, backup, and rollback proof                                     |

## Release verification status

**Pending final source-freeze verification.** Earlier V1 counts, hashes,
screenshots, backup artifacts, and commit provenance are not V1.1 release
evidence.

The minimum final command set is:

```bash
npm ci
npm audit --audit-level=high
npm run install:vroom-runtime
npm audit --prefix infra/vroom/runtime-package --audit-level=high
npm run format:check
npm run licenses:check
npm run lint
npm run typecheck
npm run check:edge
npm test
npm run test:infra
npm run build
npm run test:e2e
npm run test:supabase -- --reset
npm run eval:ai
npm run demo:proof -- --report artifacts/demo-proof-v1.1-YYYYMMDD-HHMMSS.json --with-vroom
```

The proof artifact must use a new filename. Docker/container checks,
backup/restore, schema/migration mirrors, credential/placeholder scans, fresh
screenshots, and an independent post-freeze audit must be recorded as well. A
missing dependency, skipped required test, unavailable browser, or partial run
is an error, not GREEN.

## Non-negotiable launch gates

- Complete and reconcile final source-freeze verification to one local release
  commit. Do not push or deploy as part of this release task.
- Provision a reviewed hosted Supabase environment and prove authentication,
  cross-role/cross-company isolation, private Storage, portal isolation,
  offline recovery, backup/restore, observability, and rollback.
- Use the protected administrator invitation in
  [`docs/runbooks/LIVE_SETUP_RUNBOOK.md`](runbooks/LIVE_SETUP_RUNBOOK.md).
  Remove the bootstrap claim after verifying the setup receipt and audit event.
  Setup does not publish or activate services, price books, terms, retention,
  providers, or launch authority; the ordinary workspace stays closed until
  the reviewed operating baseline activates the company.
- Rehearse the owner-only company kill switch with a second device and pending
  offline packets. Prove that new provider/automation/field/media work stops,
  already accepted provider truth and safe orphan cleanup reconcile, recovery
  diagnostics reveal no customer content, and reactivation reloads the full
  server workspace before queue replay.
- Store restricted credentials in a production secret manager. Activate one
  provider at a time and record signatures, duplicates, consent/opt-out,
  delivery, rate/spend limits, retry/timeout behavior, reconciliation, kill
  switch, and one owner-approved low-risk canary.
- Prove the exact Stripe checkout replacement, late-retired-session success,
  allocation-conflict, collection-hold, and owner-resolution behaviors against
  the reviewed staging account before moving real funds.
- Complete an encrypted backup and isolated database/Storage restore drill,
  approve retention/deletion/legal-hold procedures, and measure RPO/RTO.
- Complete every required sign-off in
  [`docs/launch/DFW-LAUNCH-CHECKLIST.md`](launch/DFW-LAUNCH-CHECKLIST.md) and
  adopt reviewed, site-specific safety/environmental/chemical SOPs using
  [`docs/launch/EXTERIOR-CLEANING-SAFETY-CHECKLIST.md`](launch/EXTERIOR-CLEANING-SAFETY-CHECKLIST.md).
- Establish TLS, secrets, database/network restrictions, monitoring/alerts,
  on-call/incident ownership, privacy-request handling, retention jobs,
  capacity/rate/spend limits, and deployment/rollback evidence.
- Select the StoryOps AI root-project license before distribution and preserve
  `LICENSE.atomic-crm.md`, `NOTICE.md`, `THIRD_PARTY.md`, and
  `NPM_THIRD_PARTY_NOTICES.txt`, plus
  `infra/vroom/runtime-package/NPM_THIRD_PARTY_NOTICES.txt` with the optional
  routing image.

Official source links in the DFW and safety checklists have been reviewed, but
their applicability has not been verified. The checklists are engineering aids,
not legal, tax, environmental, insurance, communications, privacy, or safety
approval.

## Current operating rule

Until the release evidence and manual gates above are closed, use StoryOps only
with synthetic data and sandbox providers. Local Supabase mode may be used for
synthetic RLS/RPC/Storage verification. Keep every live enable flag false.

AI may draft, inspect, calculate through trusted server tools, and propose. The
owner retains legal, safety, chemical, environmental, insurance, tax, vendor,
bank, destructive, and live-customer commitments. Any uncertainty affecting
people, money, consent, scope, availability, or provider state stops the
affected action.

No push, deployment, purchase, provider activation, customer contact, or secret
exposure is authorized by this status.
