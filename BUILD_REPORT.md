# StoryOps AI V1.1 release-candidate build report

**Report state:** **DRAFT — pending final source-freeze verification**  
**Report date:** 2026-07-29  
**Branch:** `codex/exterior-services-pilot-v1.1`  
**Source commit:** pending local release commit  
**Release posture:** **YELLOW — sandbox/operator rehearsal only; live customer
use is not authorized**  
**Data posture:** synthetic sandbox data and local synthetic Supabase fixtures
only  
**External actions:** none — no push, deployment, purchase, provider
activation, customer contact, or secret exposure

This report records the current V1.1 source boundary. It does not claim final
release verification until the source is frozen and every command in
[Final verification contract](#final-verification-contract) has completed
against that exact source. Counts, hashes, timestamps, screenshots, backup
evidence, and commit provenance remain explicitly pending below.

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

## Golden-path release contract

The source is intended to prove the following sequence after final freeze:

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

The final verification must also prove cross-role isolation, exact approval
binding, quote-acceptance idempotency, distinct checkout/payment identities,
checkout-attempt retirement, late-success quarantine, collection holds, exact
owner allocation resolution, webhook duplicates, offline recovery, audit-feed
redaction, and failure-closed behavior.

## Final verification contract

**Status:** pending final source-freeze verification.

No row may be changed to PASS from an earlier commit, a partial run, a skipped
test, or a representative screenshot.

| Check                                    | Final result                                                          |
| ---------------------------------------- | --------------------------------------------------------------------- |
| Clean locked install                     | PENDING — final source freeze                                         |
| `npm audit --audit-level=high`           | PENDING — final source freeze                                         |
| Prettier                                 | PENDING — final source freeze                                         |
| License inventory                        | PENDING — final source freeze                                         |
| ESLint                                   | PENDING — final source freeze                                         |
| TypeScript project references            | PENDING — final source freeze                                         |
| Edge/Deno checks                         | PENDING — final source freeze                                         |
| Unit/component tests                     | PENDING — final source freeze; count not yet recorded                 |
| Infrastructure tests                     | PENDING — final source freeze; count not yet recorded                 |
| Production PWA build                     | PENDING — final source freeze; bundle measurements not yet recorded   |
| Playwright desktop/mobile                | PENDING — final source freeze; count not yet recorded                 |
| Clean local Supabase reset and contracts | PENDING — final source freeze; migration/test counts not yet recorded |
| AI evaluations                           | PENDING — final source freeze                                         |
| VROOM route proof                        | PENDING — final source freeze                                         |
| Executable backup and restore dry-run    | PENDING — final source freeze; hashes and timestamps not yet recorded |
| Production container and health checks   | PENDING — final source freeze; image hash not yet recorded            |
| Credential and placeholder scans         | PENDING — final source freeze                                         |
| Independent post-freeze audit            | PENDING — final source freeze                                         |

Required commands:

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

The proof filename must be new and timestamped; prior evidence must not be
overwritten. Docker-dependent checks, the production container/health check,
backup/restore dry-run, source/schema mirror checks, and credential/placeholder
scans must also be recorded in the final evidence. An unavailable dependency
or skipped required check is an error, not a pass.

### Pending release evidence

- **Verification window:** pending final source-freeze verification
- **Node/npm/Docker/Supabase runtime versions:** pending final evidence capture
- **Machine-readable proof path:** pending unique timestamped artifact
- **Final screenshots:** pending byte-current recapture
- **Backup artifact and restore target:** pending final source-freeze run
- **Migration/schema hashes:** pending final source-freeze run
- **Container image hash and size:** pending final source-freeze run
- **Independent audit disposition:** pending post-freeze audit
- **Local release commit:** pending

## Screenshots

Fresh V1.1 screenshots are pending final source freeze and must be captured from
the exact release candidate. The required set is:

1. setup/configuration;
2. owner command center;
3. deterministic estimate and publication boundary;
4. customer portal response with typed signer and affirmative acceptance;
5. mobile field execution; and
6. AI Office.

Earlier V1 images are not release evidence for V1.1 and are intentionally not
embedded here.

## Backup and recovery posture

The repository contains logical database/roles/blob backup, manifest,
checksumming, and explicit-target restore dry-run tooling. The current recovery
contract includes the V1.1 acceptance, audit-feed, checkout-retirement, and
payment-allocation objects. Exact backup paths, migration counts, object
counts, fingerprints, timestamps, and restore results remain pending the final
source-freeze run.

Even after local proof passes, hosted backup encryption, off-site retention,
Storage export, legal hold, an isolated production-like restore drill, and
measured RPO/RTO remain manual YELLOW gates.

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

Exact pins and generated inventory must be rechecked in the final license run.
StoryOps AI's own distribution license remains undecided and is a hard gate
before distribution.

## Credentials and manual activation

No credential is required for sandbox rehearsal. No real key, card, phone
number, mailbox, calendar, customer, or job is authorized for this release
candidate.

Before any reviewed live environment:

1. finish the final source-freeze verification and independent audit;
2. provision Supabase without local demo users or synthetic seed data;
3. issue the protected one-company setup invitation described in
   [docs/runbooks/LIVE_SETUP_RUNBOOK.md](docs/runbooks/LIVE_SETUP_RUNBOOK.md);
4. verify the setup receipt/audit event and confirm generated services,
   price books, terms, retention, and providers remain inactive, draft, or
   disabled;
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
- Manual authenticated AI Office runs exist; no unattended scheduler or worker
  cadence is claimed as configured.
- QuickBooks support is a checksummed formula-safe export, not live accounting
  sync, payroll, bank, or vendor mutation.
- V1.1 is single-company and exterior-services-first. It is not SaaS billing,
  franchise management, inventory ERP, payroll, or licensed-trade diagnosis.
- Production observability collectors, dashboards, paging, support/on-call,
  retention jobs, RPO/RTO, and customer-data migration are not configured.
- Source verification is pending; this draft does not authorize a pilot.

## Next priorities

1. Freeze the source, run the complete verification contract, and resolve every
   release-blocking finding.
2. Capture byte-current V1.1 screenshots and a new machine-readable proof.
3. Run and record the independent post-freeze audit.
4. Create the local release commit without pushing or deploying.
5. Complete DFW legal/tax/insurance/environmental/safety/privacy/
   communications reviews and select the root license.
6. Prove a reviewed hosted staging environment and one provider at a time.
7. Build the recurring residential-cleaning pack as the second kernel proof.

## Release provenance

- **Branch:** `codex/exterior-services-pilot-v1.1`
- **Commit:** pending local release commit
- **Final verification:** pending exact-commit source freeze
- **Push:** not performed and not authorized by this release task
- **Deployment:** not performed and not authorized

This section must be updated only after the local commit exists and the report
is reconciled to the exact committed source.
