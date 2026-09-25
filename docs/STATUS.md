# WashOps current status

**Updated:** 2026-07-30  
**Branch:** `main`  
**Phase:** V1.1 implementation frozen and locally verified; evidence recorded
in a separate report-only commit boundary  
**Overall verdict:** **YELLOW — sandbox/operator rehearsal only; live customer
operations are not authorized**  
**Real provider/customer/money launch:** **NO-GO**  
**Owner:** company owner  
**Technical owner:** principal engineer

This file states the current operating posture. The frozen implementation
tested below is commit
`83950180d63e3455fa2047cd838ba5a2df8d9491`. Exact command output, hashes,
backup evidence, and commit provenance belong in
[`BUILD_REPORT.md`](../BUILD_REPORT.md). Documentation and evidence assembled
after that implementation freeze belong in a separate report-only commit; that
later commit must not be represented as the SHA against which the functional
matrix ran. Durable history belongs in Git and the application audit/incident
stores.

## Executive status

WashOps V1.1 implements a single-company service-business kernel and one
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

The provider-truth P1 found during the freeze is closed. A provider read or
reconciliation failure is not delivery failure. When a live provider receipt
is already known, the attempt remains `submitted`, moves to the explicit manual
`RECONCILIATION_EXHAUSTED` state, preserves its communication/provider
identity, and is excluded from automatic resend; only a verified provider
callback or deliberate reconciliation from authoritative provider evidence may
settle it. Transactional delivery is serialized by company and entity across
channels. Migration 66 repairs only unambiguous legacy rows and fails closed
when a fabricated-failure signature is ambiguous.

The four operational workers are `post_service`,
`transactional_outbound`, `scheduling_reconciliation`, and
`scope_photo_cleanup`. Local contracts prove their individual credentials,
scheduled-trigger/readiness evidence, release fingerprint/configuration hash,
current heartbeat, and bounded queues. These operational workers are distinct
from an unattended AI Office scheduler, which is not claimed configured.
Hosted scheduling, credentials, current heartbeats, release matching, and
alerting have not been proven, so worker readiness remains YELLOW.

## Readiness matrix

| Area                            | Current source posture                                                                                                                                                                                                           | Live boundary                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exterior-services product slice | Implemented and passed the frozen local release matrix for synthetic sandbox/operator rehearsal                                                                                                                                  | Operator validates every active service, formula, minimum, duration, exclusion, package, travel ZIP, tax, deposit, and margin rule                                  |
| Deterministic estimating        | Decimal/versioned rule boundary implemented and covered by the frozen local unit/integration/browser/Supabase matrix                                                                                                             | Hosted authoritative-data canary and operator/legal/tax review                                                                                                      |
| Quote and customer portal       | Published-quote projection plus exact typed/affirmative acceptance boundary implemented                                                                                                                                          | Hosted customer isolation, expiry/replay, terms, accessibility, and delivery canary                                                                                 |
| Owner audit view                | Bounded paginated redacted metadata feed implemented                                                                                                                                                                             | Hosted authorization/export/retention review; never treat it as backup or cryptographic integrity proof                                                             |
| Identity/RBAC/tenant isolation  | Auth/RLS/RPC contracts implemented                                                                                                                                                                                               | Hosted cross-role and cross-company canary, invitation/offboarding/session procedure                                                                                |
| First-company setup             | Protected invitation and guarded one-company setup boundary implemented; setup-only workspace remains operationally closed until reviewed baseline activation                                                                    | Hosted admin/Auth canary; generated artifacts remain draft/inactive/disabled and setup alone is never launch authority                                              |
| Company pause/recovery          | Owner-only finite active/paused control, immutable receipt/audit history, active-company mutation/provider gate, and minimal read-only recovery implemented                                                                      | Hosted concurrency, already-issued-token expiry, provider reconciliation, multi-device queue, alerting, and incident rehearsal                                      |
| Offline field workflow          | Scoped command/media replay and fail-closed completion implemented; pending packets survive pause and expose metadata-only recovery diagnostics                                                                                  | Hosted device-loss, quota, conflict, Storage, recovery, pause/reactivation, and update/rollback canary                                                              |
| AI Office                       | Guarded specialists, typed tools, approvals, budgets, injection defenses, redacted traces, and 18/18 frozen AI evals                                                                                                             | Model/privacy review, staged hosted canary, monitoring, kill switch, and incident owner; no unattended AI scheduler is configured                                   |
| Lead intake and communications  | Normalization, consent/opt-out, signatures, idempotency, ambiguity, cross-channel entity serialization, and fail-closed provider-truth reconciliation implemented                                                                | Owned identities, approved language, public callback and delivery/STOP/bounce/complaint canaries                                                                    |
| Stripe billing                  | Checkout/invoice/refund, `cs_*`/`pi_*` separation, attempt retirement, allocation quarantine, holds, and exact resolution implemented                                                                                            | Account/tax review plus signed webhook, replacement/late-success, amount, idempotency, and reconciliation canaries                                                  |
| Calendar/maps/weather/routing   | Guarded provider interfaces and durable evidence contracts implemented                                                                                                                                                           | Reviewed credentials/endpoints/quotas and fresh provider canaries                                                                                                   |
| Provider/launch authority       | Trusted environment generations, finite owner activation/disable, append-only launch authorization/revocation, dynamic health checks, live-start/database booking gates, and four local operational-worker contracts implemented | Hosted deployment probes, all four scheduled workers/readiness heartbeats, real capability canaries, trusted field-media/restore proofs, and owner launch rehearsal |
| Photo-assisted scope            | Bounded evidence/unknown contracts and private Storage workflows implemented                                                                                                                                                     | Hosted media/privacy/content process, quota/lifecycle, signed-link expiry, and representative-media canary                                                          |
| Core field media                | Private Storage/RLS/Edge finalization boundary implemented                                                                                                                                                                       | Hosted Auth/device-loss/quota/tamper/recovery proof                                                                                                                 |
| Customer photo upload           | Authenticated customer/staff requests use bounded private signed uploads, exact byte/hash finalization, tenant/customer/asset binding, retention state, and orphan cleanup                                                       | Hosted abuse/quota/content controls, cleanup scheduling/alerting, customer isolation, and representative upload/recovery canary                                     |
| Materials and SDS               | Exact configuration-bound PDF checksum workflow, private write-once upload, server byte/PDF/SHA-256 attestation, immutable document versions, and publication/baseline/field gates implemented                                   | Adopted manufacturer documents/SOPs, qualified review, hosted private-Storage/tamper/offline-device canary, retention/legal hold                                    |
| QuickBooks                      | Formula-safe checksummed export boundary implemented                                                                                                                                                                             | Accountant mapping/import acceptance; no live ledger mutation                                                                                                       |
| Backup/restore                  | Isolated loopback restore proved migration 66 plus 3 private Storage objects/204 bytes with detached manifest and signed HMAC evidence; the disposable target was cleaned up                                                     | Hosted encryption, off-site retention, independently operated restore drill, RPO/RTO measurement, and recovery acceptance remain open                               |
| Observability                   | Runtime health, logs, traces, incidents, and runbooks present                                                                                                                                                                    | Production collector, dashboards, alerts, paging, on-call, and rollback evidence                                                                                    |
| DFW launch/compliance           | Official-source engineering checklists present                                                                                                                                                                                   | Professional and jurisdiction-specific legal/tax/insurance/environmental/safety/privacy/communications sign-offs                                                    |
| Distribution license            | Upstream notices and third-party inventory preserved                                                                                                                                                                             | Select and record WashOps's root license before distribution                                                                                                    |
| Release evidence                | Frozen implementation `83950180d63e3455fa2047cd838ba5a2df8d9491` passed the complete local matrix; independent audit ended at P0=0/P1=0; fresh V1.1 screenshots were unavailable                                                 | Evidence-only report commit must remain distinct; fresh manual screenshots and all hosted/manual launch proofs remain open                                          |
| Deployment                      | Not performed                                                                                                                                                                                                                    | Reviewed hosting, TLS, secret manager, access controls, monitoring, backup, and rollback proof                                                                      |

## Release verification status

The complete local verification matrix passed against frozen implementation
`83950180d63e3455fa2047cd838ba5a2df8d9491`:

| Frozen gate                     | Exact result                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install and dependency audits   | Root and pinned VROOM runtime installs passed; both high-severity audits reported 0 vulnerabilities                                                                                |
| Static/source gates             | Format, license inventory, lint, TypeScript, Edge checks (128/128), and `git diff --check` passed                                                                                  |
| Application tests               | Vitest 409/409 passed                                                                                                                                                              |
| Infrastructure tests            | 52/52 passed                                                                                                                                                                       |
| Disposable upgrade contract     | `npm run test:upgrade` passed the isolated pre-62 to migration-62 field-media canary upgrade                                                                                       |
| Migration 66 upgrade guard      | Clean-reset and SQL regression coverage passed for unambiguous repair and fail-closed ambiguity; a separate disposable pre-66 abort rehearsal remains a non-blocking hardening gap |
| Production build                | `npm run build` passed                                                                                                                                                             |
| Browser tests                   | Playwright 28/28 passed                                                                                                                                                            |
| Local Supabase release contract | Clean reset applied all 67 migrations, then passed SQL contracts, concurrency tests, authenticated Storage/RLS/RPC checks, and live local Edge tests                               |
| AI evals                        | 18/18 passed                                                                                                                                                                       |
| Independent release audit       | P0=0 and P1=0 after closing the provider-truth P1                                                                                                                                  |

The clean demo proof is
[`artifacts/demo-proof-v1.1-20260731T0300Z.json`](../artifacts/demo-proof-v1.1-20260731T0300Z.json),
SHA-256
`8439838e3a59fab7a4a7b5fdacb193292d63924661a2b57a7b516ba3afbaf213`.
The isolated backup manifest SHA-256 is
`b51e0b03891e5e66cb8a31db7dfcb53b47752d48701c0fbc9fdaabcfcfae2490`;
restore evidence verified migration `20260728660000`, 3 objects/204 bytes,
the detached manifest, and the HMAC signature before the isolated target was
removed.

The hardened application image was healthy at local digest
`sha256:2d413155a3eba850edf1968516521e0bb622f9b9987f8c4f9ea2d672628ee6b5`.
The hardened VROOM image was healthy at local digest
`sha256:dc13226d56361ffe7a895806910076a4be999746aeefd0d2e9f7dca692ca29b4`.
These are local image identities, not registry attestations or deployment
proof.

Fresh V1.1 manual screenshots could not be captured because the in-app browser
was unavailable. The four existing images under `artifacts/screenshots/` are
legacy 2026-07-28 evidence and are explicitly excluded from this V1.1 proof.
That absence is a documented evidence limitation, not a substituted or fake
success.

## Non-negotiable launch gates

- Preserve the frozen implementation SHA above and record subsequent report
  material in a separate evidence-only commit. Do not imply that functional
  tests ran against that later documentation commit. Do not push or deploy as
  part of this release task.
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
- Pin production base images to reviewed immutable identities and complete a
  final OS/container vulnerability scan plus SBOM/provenance attestation.
  Ubuntu package repositories used by the current build are not immutable
  snapshots, so the local image checks do not close this supply-chain gate.
- Complete every required sign-off in
  [`docs/launch/DFW-LAUNCH-CHECKLIST.md`](launch/DFW-LAUNCH-CHECKLIST.md) and
  adopt reviewed, site-specific safety/environmental/chemical SOPs using
  [`docs/launch/EXTERIOR-CLEANING-SAFETY-CHECKLIST.md`](launch/EXTERIOR-CLEANING-SAFETY-CHECKLIST.md).
- Establish TLS, secrets, database/network restrictions, monitoring/alerts,
  on-call/incident ownership, privacy-request handling, retention jobs,
  capacity/rate/spend limits, and deployment/rollback evidence.
- Select the WashOps root-project license before distribution and preserve
  `LICENSE.atomic-crm.md`, `NOTICE.md`, `THIRD_PARTY.md`, and
  `NPM_THIRD_PARTY_NOTICES.txt`, plus
  `infra/vroom/runtime-package/NPM_THIRD_PARTY_NOTICES.txt` with the optional
  routing image.

Official source links in the DFW and safety checklists have been reviewed, but
their applicability has not been verified. The checklists are engineering aids,
not legal, tax, environmental, insurance, communications, privacy, or safety
approval.

## Current operating rule

Despite the passing local matrix, use WashOps only with synthetic data and
sandbox providers until every hosted and manual gate above is closed. Local
Supabase mode may be used for synthetic RLS/RPC/Storage verification. Keep
every live enable flag false.

AI may draft, inspect, calculate through trusted server tools, and propose. The
owner retains legal, safety, chemical, environmental, insurance, tax, vendor,
bank, destructive, and live-customer commitments. Any uncertainty affecting
people, money, consent, scope, availability, or provider state stops the
affected action.

No push, deployment, purchase, provider activation, customer contact, or secret
exposure is authorized by this status.
