# StoryOps AI V1.1 release-candidate build report

**Report state:** **LOCAL RELEASE EVIDENCE COMPLETE — live launch gates remain**  
**Report date:** 2026-07-30 (CDT); evidence completed 2026-07-31 (UTC)  
**Branch:** `codex/exterior-services-pilot-v1.1`  
**Tested implementation commit:**
`83950180d63e3455fa2047cd838ba5a2df8d9491`  
**Evidence boundary:** this document and its machine-readable artifact belong
to a separate evidence-only commit boundary; that boundary is not the
implementation SHA tested below  
**Release posture:** **YELLOW — sandbox/operator rehearsal only; live customer
use is not authorized**  
**Data posture:** synthetic sandbox data and local synthetic Supabase fixtures
only  
**External actions:** none — no push, deployment, purchase, provider
activation, customer contact, or secret exposure

This report records the verified local V1.1 source boundary. The complete
matrix below passed against the clean implementation commit
`83950180d63e3455fa2047cd838ba5a2df8d9491`. This report and its evidence are
being committed afterward, so the later evidence commit must not be described
as the source SHA that was tested. No hosted deployment, real-provider canary,
customer contact, or movement of money occurred.

## Outcome

StoryOps AI V1.1 is a production-shaped operating system for one
owner-operated exterior-cleaning company. Its first repository-controlled
industry pack covers pressure/soft washing, gutter/downspout cleaning, roof
washing, exterior window cleaning, and related exterior add-ons.

The reusable kernel covers:

1. multi-channel lead intake, qualification, customer, property, consent, and
   communication records;
2. bounded photo-assisted scope with evidence, confidence, unknowns, and
   human-confirmed measurements;
3. versioned Decimal price books and deterministic estimates;
4. policy evaluation and exact owner approvals;
5. quote publication, exact customer acceptance, terms, deposit, and portal
   access;
6. capacity-, equipment-, calendar-, route-, and weather-aware booking;
7. role-scoped mobile field execution with offline replay, checklists, time,
   materials/SDS, before/after media, notes, incidents, and signature;
8. invoice, checkout, payment, refund, and reconciliation boundaries;
9. consent-aware review, referral, follow-up, and recurring maintenance; and
10. governed AI Office specialists, redacted traces, audit events, runbooks,
    and incident controls.

V1.1 does not claim arbitrary-industry support. Industry-specific services,
measurement vocabularies, pricing templates, scope evidence, equipment,
checklists, safety inputs, and recurring defaults remain pack-owned. The next
planned proof is a recurring residential-cleaning pack without a core fork.

## Delivered architecture

| Layer            | V1.1 source boundary                                                                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product          | React/Vite responsive PWA with setup, command center, pipeline, customers/properties, estimate/quote, portal, dispatch, field, finance, AI Office, approvals, operations, integrations, and owner audit views                                 |
| Sandbox          | No-key synthetic state in IndexedDB, explicit sandbox provider receipts, and idempotent offline command/media replay                                                                                                                          |
| Domain           | Base-10 Decimal pricing, versioned catalog/price-book rules, evidence references, policy decisions, booking constraints, permissions, and financial/customer contracts                                                                        |
| Data plane       | Supabase Auth, normalized PostgreSQL schema, private Storage, RLS/RBAC, role-projected reads, finite optimistic-version commands, immutable audit records, and migration-controlled RPCs                                                      |
| Server workflows | Guarded setup, authoritative estimating, quote acceptance, booking/field/invoice transitions, post-service outbound, webhook reconciliation, refund execution, checkout retirement, payment-allocation quarantine, and exact owner resolution |
| AI Office        | Orchestrator plus intake, estimating, scheduling, follow-up, marketing, finance, safety, and owner-briefing specialists with typed least-privilege tools, structured outputs, injection defenses, budgets, approvals, and redacted traces     |
| Integrations     | Sandbox and disabled-until-configured boundaries for OpenAI, Twilio voice/SMS, email, Stripe, Google Calendar, maps/geocoding, NWS, VROOM, Storage, and QuickBooks export                                                                     |
| Operations       | Container/runtime controls, health metadata, setup checks, backup/restore tooling, observability contracts, runbooks, incident records, retention posture, CI definitions, and release-proof tooling                                          |

Authoritative operating rules live in
[docs/SOURCE_OF_TRUTH.md](docs/SOURCE_OF_TRUTH.md). Architecture detail is in
[docs/architecture/AI_OFFICE.md](docs/architecture/AI_OFFICE.md) and
[docs/architecture/INTEGRATIONS.md](docs/architecture/INTEGRATIONS.md).

## V1.1 truth and safety invariants

- Price, tax, deposit, duration, margin, discount, and line-item values come
  from the selected published price-book version and deterministic Decimal
  formulas. AI does not supply measurements, prices, availability, payment
  state, regulations, or chemical/safety instructions.
- Draft or exception-priced estimates are not customer-visible until their
  exact policy/approval conditions are satisfied and the quote is published.
  Publication is not proof of SMS or email delivery.
- Quote acceptance requires a typed signer and affirmative acknowledgement of
  the exact quote version, terms version, and total. The server writes
  append-only acceptance evidence; a generic quote-status mutation is not an
  acceptance substitute.
- The owner audit UI uses a bounded, paginated, redacted metadata feed. It does
  not expose raw audit payloads or actor IDs, and it is not represented as a
  backup or cryptographic integrity proof.
- Stripe Checkout Session identity (`cs_*`) is distinct from PaymentIntent
  identity (`pi_*`). Failed or expired checkout attempts are retired before
  replacement. A late success from a retired attempt is quarantined rather than
  silently applied.
- A signed provider event does not by itself make funds safely allocatable.
  Overpayment, underpayment, identity mismatch, retired-session success, or
  other verified-but-unapplied funds create a reconciliation conflict and hold
  collection-dependent automation.
- Only an owner, with the exact approved conflict and current invoice/payment
  versions, may apply a verified payment whose amount still exactly equals the
  current invoice balance. Every other conflict remains manual
  provider/accounting work; approval does not bypass server revalidation.
- A provider redirect, queued request, local receipt, webhook receipt, or
  browser state alone never means paid, refunded, delivered, booked, or
  accepted. Stable identities, exact values, signatures, idempotency, and
  authoritative reconciliation are required.
- A provider read or reconciliation failure is not provider delivery failure.
  If StoryOps has a stable live provider message ID but cannot determine the
  final outcome after bounded reads, the attempt remains `submitted` with
  `RECONCILIATION_EXHAUSTED`; the provider identity and communication record
  are preserved, automatic resend is excluded, and only a verified provider
  callback or deliberate reconciliation from authoritative provider evidence
  may settle it. Active transactional attempts are serialized
  per company and business entity across channels so an ambiguous SMS cannot
  silently fall through to email. Migration 66 repairs only unambiguous legacy
  fabricated-failure state and fails closed when legacy evidence is ambiguous.
- Booking cannot bypass accepted-quote evidence, deposit truth, capacity,
  equipment, route, calendar, and weather evidence.
- Field completion requires the assigned active visit, required checklist
  items, durable before/after evidence and signature, stopped timers, notes,
  material/SDS records, and no unresolved incident.
- Price exceptions, large discounts, refunds, legal/safety messages,
  negative-review replies, campaigns, vendor/bank actions, destructive
  changes, and work outside approved price books/SOPs require exact approval or
  remain human-only.
- External text, transcripts, OCR, reviews, and photo observations remain
  untrusted data. They cannot expand authority or rewrite policy.
- Live launch depends on four exact-company private workers:
  `post_service`, `transactional_outbound`, `scheduling_reconciliation`, and
  `scope_photo_cleanup`. Each requires its own dedicated credential and
  scheduled trigger, the expected release fingerprint and configuration hash,
  a current scheduled heartbeat, and bounded queue evidence. Missing, stale,
  unknown, or drifted worker evidence blocks launch. These operational workers
  are separate from the intentionally absent unattended AI Office scheduler.

## Golden-path release contract

The verified local source proves the following sandbox sequence:

```text
lead
→ qualification and property
→ bounded scope evidence
→ deterministic estimate
→ policy or exact approval
→ published quote and exact customer acceptance
→ deposit and capacity-aware booking
→ route/weather/equipment check
→ offline-capable field execution
→ evidence-backed completion
→ invoice and provider reconciliation
→ review/referral
→ recurring maintenance
```

The final verification also proved cross-role isolation, exact approval
binding, quote-acceptance idempotency, distinct checkout/payment identities,
checkout-attempt retirement, late-success quarantine, collection holds, exact
owner allocation resolution, webhook duplicates, offline recovery, audit-feed
redaction, and failure-closed behavior.

## Final verification contract

**Status:** **PASS for local sandbox/release rehearsal at implementation commit
`83950180d63e3455fa2047cd838ba5a2df8d9491`; YELLOW for live launch.**

No result below is carried from an earlier commit, inferred from a
representative test, or upgraded from a skipped check.

| Check                                    | Final result                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clean locked install                     | **PASS** — `npm ci` added 599 packages, audited 600, and reported 0 vulnerabilities                                                                                                              |
| Root and VROOM runtime high audits       | **PASS** — both `npm audit --audit-level=high` runs reported 0 vulnerabilities                                                                                                                   |
| Prettier and diff hygiene                | **PASS** — format check and `git diff --check`                                                                                                                                                   |
| License inventory                        | **PASS** — root and separately locked VROOM runtime notices matched their installed graphs                                                                                                       |
| ESLint                                   | **PASS** — zero warnings                                                                                                                                                                         |
| TypeScript project references            | **PASS**                                                                                                                                                                                         |
| Edge/Deno checks                         | **PASS** — 128/128 Edge contract tests                                                                                                                                                           |
| Unit/component tests                     | **PASS** — Vitest 84/84 files and 409/409 tests                                                                                                                                                  |
| Infrastructure tests                     | **PASS** — Node TAP 52/52 tests                                                                                                                                                                  |
| Disposable upgrade rehearsal             | **PASS** — isolated pre-62 stack upgraded through migration `20260728620000`; migration SHA-256 `3a9933dd085fac4c80f5a5f9dcff3c492c0c4415ac34dd0dde91d750fdc7cda6`                               |
| Production PWA build                     | **PASS** — Vite 8.1.5; PWA precache 63 entries / 1506.91 KiB; largest chunk `Primitives` 740.99 kB / 196.99 kB gzip                                                                              |
| Playwright desktop/mobile                | **PASS** — 28/28 across Chromium desktop and mobile projects                                                                                                                                     |
| Clean local Supabase reset and contracts | **PASS** — all 67 migrations, seed, SQL contracts, concurrency checks, and live local Edge contracts completed from a clean reset                                                                |
| AI evaluations                           | **PASS** — 18/18                                                                                                                                                                                 |
| VROOM build, health, and route proof     | **PASS** — exact pinned image healthy; deterministic route returned 1 route, 0 unassigned, 1,200 seconds, and 16,000 meters                                                                      |
| Backup dry-run and executable restore    | **PASS** — dry-run safety contract plus a signed, isolated, executable database/Storage restore; source and target identities were distinct and the isolated target was cleaned up               |
| Production container and health checks   | **PASS** — `arm64` image healthy as a non-root user with read-only filesystem, all capabilities dropped, and loopback-only publication; runtime reported the exact compiled implementation SHA   |
| Credential and source-hygiene scans      | **PASS** — proof began from a clean source tree, recorded `providerCredentialsUsed: false`, and the independent source-hygiene audit found no release-blocking credential or placeholder finding |
| Independent final audit                  | **PASS** — 0 P0 and 0 P1 findings after remediation. The initial provider-truth P1 was fixed and its SQL, Edge, mirror, and clean-reset contracts passed                                         |

Commands executed for the tested implementation:

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
git diff --check
npm test
npm run test:infra
npm run test:upgrade
npm run build
npm run test:e2e
npm run test:supabase -- --reset
npm run eval:ai
npm run demo:proof -- --report artifacts/demo-proof-v1.1-YYYYMMDD-HHMMSS.json --with-vroom
```

The proof filename is new and timestamped; no earlier artifact was overwritten.
Docker-dependent checks, the production container/health check, executable
backup/restore, source/schema mirror checks, and credential/source-hygiene
checks were recorded separately from the machine-readable golden-path proof.

### Release evidence

- **Verification window:** 2026-07-30 CDT / 2026-07-31 UTC
- **Tested implementation SHA:**
  `83950180d63e3455fa2047cd838ba5a2df8d9491`
- **Toolchain:** Node 22.22.3; npm 10.9.8; Docker client 29.6.1 / server
  29.2.1; Supabase CLI 2.110.0
- **Machine-readable proof:**
  `artifacts/demo-proof-v1.1-20260731T0300Z.json`, SHA-256
  `8439838e3a59fab7a4a7b5fdacb193292d63924661a2b57a7b516ba3afbaf213`;
  status `passed`, full sandbox mode, clean source at start, no skipped E2E,
  and no provider credentials used
- **Executable restore:** `backups/restore-drill-20260731T025435Z`; trusted
  manifest SHA-256
  `b51e0b03891e5e66cb8a31db7dfcb53b47752d48701c0fbc9fdaabcfcfae2490`
- **Database recovery authority:** 67 migrations; migration-set fingerprint
  `98979fde9f841c360d1729ae8312f7f1c332175b51018633533baba9f3c1d894`;
  schema fingerprint
  `9a0ea4fa6835818adbd08af70c48651240a5ea411d06f48a2b45e48474168e2d`
- **Storage recovery:** 3 private objects / 204 bytes; verified-byte
  fingerprint
  `2d7211ff109bd741427ecc7bd9431c6326dd0b48f7fa24a518823a54399e0ea7`
- **VROOM artifact:** VROOM v1.15.0 at
  `43dd7d0b8b560431eb555bf335cf4797eb7343c4`; vroom-express v0.12.0 at
  `5475901e60ec13ed9eec6cc87c811206a779eb03`; image ID
  `sha256:dc13226d56361ffe7a895806910076a4be999746aeefd0d2e9f7dca692ca29b4`
- **Application container:** image ID
  `sha256:2d413155a3eba850edf1968516521e0bb622f9b9987f8c4f9ea2d672628ee6b5`;
  Docker image size 57,691,157 bytes; Linux `arm64`
- **Independent audit:** final disposition 0 P0 / 0 P1
- **Screenshots:** no fresh V1.1 screenshots were captured; the four legacy V1
  images dated 2026-07-28 are explicitly excluded from this release evidence
- **Evidence boundary:** this reconciled report and its artifact belong to a
  separate evidence-only commit boundary; that boundary is not represented as
  having undergone the implementation matrix

## Screenshots

Fresh V1.1 screenshots were unavailable in the final verification environment.
The four files under `artifacts/screenshots/` are legacy V1 images captured on
2026-07-28; they are intentionally excluded and are not evidence for the V1.1
implementation SHA. The automated desktop/mobile UI result is the 28/28
Playwright pass, not a substitute claim that screenshots were captured.

Before a live pilot, recapture setup/configuration, owner command center,
deterministic estimate/publication, exact customer acceptance, mobile field
execution, and AI Office from the reviewed hosted candidate.

## Backup and recovery posture

The local recovery proof is executable, not a mocked success. At
`backups/restore-drill-20260731T025435Z`, StoryOps verified the independently
retained manifest digest, staged authenticated bytes without following
symlinks, restored the complete logical database/roles and three private
Storage objects to a fresh loopback-only target, and derived the fingerprints
above from the target. The source and target database system identities were
different. The HMAC-signed proof verified, was written owner-only at mode
`0600`, and bound the restore request and evidence; the exact isolated restore
target was cleaned up afterward.

This remains local synthetic evidence. Hosted backup encryption, encrypted
off-site retention, legal hold, a production-like hosted recovery drill,
measured RPO/RTO, and a named recovery operator remain manual YELLOW gates.

## Licensing and upstream provenance

- `marmelab/atomic-crm` is the MIT foundation. Its notice is preserved in
  `LICENSE.atomic-crm.md` and `NOTICE.md`.
- `rupret007/StoryLand-Driving-School` supplied operating-pattern inspiration.
  No unlicensed source or text is claimed as copied.
- `OCA/field-service` was used only as an AGPL domain checklist; StoryOps does
  not copy its code/schema/assets or adopt AGPL.
- VROOM/vroom-express and OpenAI Agents JS are pinned dependencies with their
  licenses and revisions recorded in [THIRD_PARTY.md](THIRD_PARTY.md).
- Direct and transitive npm notices are recorded in
  [NPM_THIRD_PARTY_NOTICES.txt](NPM_THIRD_PARTY_NOTICES.txt); the separately
  locked VROOM runtime graph is recorded in
  [its exact runtime inventory](infra/vroom/runtime-package/NPM_THIRD_PARTY_NOTICES.txt)
  and copied into the routing image.

Exact pins and generated inventory were rechecked in the final license run, and
the final license check passed for both npm graphs. However, StoryOps AI's own
distribution license remains undecided, the VROOM image's Ubuntu apt
repositories are not pinned to an immutable snapshot, and no final OS/container
CVE scan or signed SBOM attestation was captured. Those are distribution and
hosted-launch gates even though the npm high-severity audits passed.

## Credentials and manual activation

No credential is required for sandbox rehearsal. No real key, card, phone
number, mailbox, calendar, customer, or job is authorized for this release
candidate.

Before any reviewed live environment:

1. provision Supabase without local demo users or synthetic seed data;
2. issue the protected one-company setup invitation described in
   [docs/runbooks/LIVE_SETUP_RUNBOOK.md](docs/runbooks/LIVE_SETUP_RUNBOOK.md);
3. verify the setup receipt/audit event and confirm generated services,
   price books, terms, retention, and providers remain inactive, draft, or
   disabled;
4. configure and monitor all four required private workers with dedicated
   credentials, scheduled triggers, exact release/configuration evidence,
   current heartbeats, and bounded queues;
5. store secrets only in an approved server-side secret manager;
6. activate one provider at a time with both required enable switches;
7. prove signatures, duplicates, consent/opt-out, delivery, rate/spend limits,
   retries, reconciliation, kill switches, and one owner-approved low-risk
   canary;
8. prove hosted RLS/RBAC, private Storage, offline recovery, monitoring,
   backup/restore, TLS, and rollback; and
9. close the professional launch gates.

Setup completion never authorizes launch, publishes pricing/terms, activates a
provider, contacts a customer, or moves money.

## Legal, safety, and DFW launch posture

Official-source links have been reviewed and registered in the launch
checklists, but applicability has not been verified:

- [Fort Worth commercial mobile cosmetic cleaning](https://www.fortworthtexas.gov/departments/environmental-services/environmental-quality/stormwater-quality/powerwash)
- [TCEQ cross-connection control](https://www.tceq.texas.gov/drinkingwater/cross-connection)
- [Texas Comptroller taxable services guidance](https://comptroller.texas.gov/taxes/publications/94-111.php)
- [FCC order DA 26-12](https://docs.fcc.gov/public/attachments/DA-26-12A1.pdf)
- [Texas Attorney General consumer AI rights](https://www.texasattorneygeneral.gov/consumer-protection/file-consumer-complaint/consumer-ai-rights)

These links and the engineering checklists are not legal, tax, environmental,
insurance, communications, privacy, or safety advice. Professional and
jurisdiction-specific review, adopted products/SDS/SOPs, wastewater/backflow/
permit decisions, consent language, terms, retention, insurance, and tax
treatment remain unsigned launch gates.

## Known limits

- No hosted environment, production authentication flow, real provider
  credential, external canary, customer record, payment, or production restore
  drill has been exercised.
- Authenticated customer and staff scope-photo capture is implemented with
  bounded signed uploads, exact byte/hash finalization, private tenant scope,
  retention state, and an orphan-cleanup worker. A deployment still needs
  Storage quota/content controls, a monitored cleanup schedule, and a hosted
  isolation/recovery canary before live use.
- Manual authenticated AI Office runs exist; no unattended AI scheduler is
  claimed. The four operational worker contracts and local readiness evidence
  are implemented, but no hosted schedules, credentials, current heartbeats,
  queue monitoring, or provider canaries are claimed.
- QuickBooks support is a checksummed formula-safe export, not live accounting
  sync, payroll, bank, or vendor mutation.
- V1.1 is single-company and exterior-services-first. It is not SaaS billing,
  franchise management, inventory ERP, payroll, or licensed-trade diagnosis.
- Production observability collectors, dashboards, paging, support/on-call,
  retention jobs, RPO/RTO, and customer-data migration are not configured.
- Ubuntu apt inputs for VROOM are not immutable-snapshot pinned; no final
  OS/container CVE scan or signed SBOM attestation is release evidence.
- Migration 66's unambiguous repair and fail-closed ambiguity guard passed the
  clean-reset and SQL regressions, but a separate disposable pre-66 data upgrade
  rehearsal was not executed. That is a non-blocking hardening gap, not hosted
  upgrade evidence.
- The root StoryOps AI distribution license remains undecided.
- Local verification does not authorize a pilot.

## Next priorities

1. Commit this evidence/report update locally without pushing or deploying.
2. Configure a reviewed hosted staging environment and prove all four private
   worker schedules, release/configuration fingerprints, current heartbeats,
   bounded queues, drift blocking, and operator alerts.
3. Capture fresh V1.1 screenshots from that exact reviewed candidate.
4. Canary one provider at a time, including ambiguous read-back and
   provider-callback reconciliation without duplicate cross-channel delivery.
5. Complete DFW legal/tax/insurance/environmental/safety/privacy/
   communications reviews and select the root license.
6. Pin or snapshot VROOM's apt inputs and produce reviewed OS/container CVE and
   SBOM attestations.
7. Prove hosted encryption, off-site backup, isolated recovery, RPO/RTO,
   TLS/secrets, alerts/on-call, spend controls, and rollback.
8. Obtain accountant acceptance for the QuickBooks export.
9. Build the recurring residential-cleaning pack as the second kernel proof.

## Release provenance

- **Branch:** `codex/exterior-services-pilot-v1.1`
- **Tested implementation commit:**
  `83950180d63e3455fa2047cd838ba5a2df8d9491`
- **Evidence/report commit:** separate later local commit; it records the
  implementation evidence but was not itself the implementation SHA under test
- **Final verification:** local matrix PASS at the tested implementation
  commit; live launch remains YELLOW
- **Push:** not performed and not authorized by this release task
- **Deployment:** not performed and not authorized

No statement in this report should be read as hosted deployment, live-provider
activation, customer authorization, payment authorization, legal/safety
approval, or distribution approval.
