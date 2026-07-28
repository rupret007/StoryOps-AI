# StoryOps AI current status

**Updated:** 2026-07-28  
**Branch:** `codex/storyops-v1`  
**Phase:** V1 vertical slice complete; external launch evidence pending  
**Overall verdict:** **YELLOW — implementation complete, not approved for live customer operations**  
**Owner:** company owner  
**Technical owner:** principal engineer

This file is updated in place and states current posture. Command transcripts
and screenshots belong in `BUILD_REPORT.md`; durable history belongs in Git and
the audit/incident stores.

## Executive status

The repository implements the coherent exterior-services golden path, domain
and policy controls, Supabase schema/RLS/RPC data plane, guarded AI office,
sandbox and opt-in live provider adapters, normalized ingress, durable webhook
reconciliation, PWA/offline behavior, infrastructure scripts, tests, and
operating documentation. Field completion now fails closed on checklist,
before/after PNG evidence, signature, stopped time, notes, material/SDS, and
incident state. Provider-proven paid invoices can queue consent-aware review/
referral follow-up and create source-bound recurring plans without claiming
provider delivery.

The browser has two explicit data modes. Default sandbox mode uses only
synthetic `DemoState` persisted in IndexedDB. Supabase mode uses magic-link
authentication, derives the role from an active membership, loads a
role-projected workspace through `get_storyops_workspace`, and sends ordinary
finite workspace mutations through `execute_storyops_command`. First-company
setup and field-media finalization use separate, narrower guarded boundaries;
the generic command RPC explicitly rejects `media.register`. Offline live
commands retain their canonical payload, request hash, optimistic version, and
command ID for replay. Visit media/signature bytes, stable UUIDs, SHA-256
hashes, exact finalization work, and dependencies persist in the scoped
IndexedDB packet; completion remains pending until Storage read-back and the
trusted media/completion RPCs reconcile.

Dedicated server workflows cover setup, estimating, quote-to-invoice
transitions, exact approved refunds, post-service outbound, field-media
finalization, normalized ingress, and provider webhook reconciliation.
`estimate-workflow` loads authoritative evidence, the effective price book,
derived travel, customer tax state, and an approved terms record before
atomically creating an estimate, lines, quote, approval, and replay receipt.
`golden-path` advances an accepted quote through deposit checkout,
provider-confirmed payment, checked booking, field completion, and invoice
issuance. The local terms record is a synthetic test fixture and no external
provider canary has been run.

The V1 release is not yet authorized for real customers. No hosted environment,
real provider credentials, external canary, or production restore drill was
provided or exercised. Required DFW legal, tax, insurance, environmental,
communications, privacy/retention, and safety reviews remain unsigned, and the
root-project distribution license is undecided.

## Readiness matrix

| Area                              | Verdict | Evidence / exact boundary                                                                                                                                                                                             |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responsive product shell          | GREEN   | Owner/dispatcher/technician/customer views and complete sandbox golden-path interactions                                                                                                                              |
| Deterministic pricing             | GREEN   | Decimal engine, versioned rules, evidence references, tax/deposit/margin/approval flags                                                                                                                               |
| Authenticated live estimating     | YELLOW  | Server-owned evidence/terms/price snapshot, atomic estimate/quote/approval and replay pass locally; hosted/legal canary pending                                                                                       |
| Quote-to-invoice live workflow    | YELLOW  | Accepted quote, deposit truth, checked booking, field completion and invoice contracts pass locally; provider canary pending                                                                                          |
| Authenticated Supabase workspace  | YELLOW  | Magic-link auth, server-derived role, role projection, finite command RPC, RLS; hosted auth canary pending                                                                                                            |
| Authenticated first-company setup | YELLOW  | Protected invitation claim, guarded setup RPC, exact replay/conflict, takeover/direct-DML denial, and draft-disabled artifacts pass locally; hosted admin/Auth canary pending                                         |
| Offline PWA field workflow        | YELLOW  | Scoped IndexedDB command/media packet, ordered idempotent replay, durable Storage read-back, retained conflicts, and non-optimistic completion pass locally; hosted/device-loss recovery pending                      |
| AI office policy                  | GREEN   | Typed specialists/tools, structured output, injection defense, exact approvals, traces, replay                                                                                                                        |
| AI fact/pricing authority         | GREEN   | Edge ignores client fact values; server loads company facts and recalculates stored estimates deterministically                                                                                                       |
| AI operational budgets            | GREEN   | Durable user/company/token windows and redacted tracing are implemented                                                                                                                                               |
| Exact approved refund execution   | YELLOW  | Owner-only Edge executor, atomic lease, state/amount revalidation, receipt and replay exist; Stripe canary pending                                                                                                    |
| Provider sandbox suite            | GREEN   | No-key, idempotent, explicit sandbox receipts and health contracts                                                                                                                                                    |
| Normalized lead intake            | YELLOW  | Signed web/chat/email and Twilio SMS/voice normalize to lead/thread/message/consent; public callback canary pending                                                                                                   |
| Provider webhook reconciliation   | YELLOW  | Verified Stripe/Twilio/email events atomically update payment/invoice/delivery/consent state; canary pending                                                                                                          |
| Photo-assisted scope              | YELLOW  | Evidence/unknown contracts, scoped Storage, and gated vision Edge exist; hosted media/vision canary pending                                                                                                           |
| OpenAI live adapter               | YELLOW  | Node/Edge Agents SDK, explicit kill switches and budgets exist; credential/eval/spend canary pending                                                                                                                  |
| Twilio/email live outbound        | YELLOW  | Twilio post-service sends use a no-resend unknown-submission quarantine plus signed delivery/STOP gates; live marketing email is disabled until signed unsubscribe/suppression; account/legal/canary pending          |
| Stripe live billing               | YELLOW  | Checkout/Invoicing/refund, customer mapping, amount validators, signed reconciliation; account/tax/canary pending                                                                                                     |
| Google Calendar/maps              | YELLOW  | Allowlisted calendar, OAuth refresh, validated free/busy/events and geocoding; credential/quota/canary pending                                                                                                        |
| NWS/VROOM live reads              | YELLOW  | Response validation, finite timeouts and route completeness checks exist; production endpoints/canary pending                                                                                                         |
| Core Supabase field media         | YELLOW  | Local assigned-user actual-PNG/tamper/replay/overwrite/completion canary passes; mandatory private RLS + Edge byte/magic + service attestation path still needs hosted device-loss/quota proof                        |
| Customer scope-photo upload       | YELLOW  | Direct customer Storage writes are closed until a bounded quota/rate/lifecycle finalizer and orphan cleanup exist; staff-assisted intake remains manual                                                               |
| Optional signed Storage targets   | YELLOW  | Separately named two-switch server adapter with scoped expiring targets; no live credential/canary                                                                                                                    |
| QuickBooks integration            | YELLOW  | Formula-safe, checksummed CSV export only; accountant mapping/import acceptance pending                                                                                                                               |
| Integration health                | YELLOW  | Optional-provider probes are separate from core field-media readiness; authenticated owner/dispatcher budgeted checks exist, hosted providers are unproven                                                            |
| Observability                     | YELLOW  | Static-runtime logs/health and redacted durable traces exist; production collector/dashboards/alerts pending                                                                                                          |
| Backup/restore                    | YELLOW  | Real local 3-file backup with all 12 migrations and three actual private-bucket PNG objects plus checksum/target restore dry-run passed; production encryption, off-site retention and isolated restore drill pending |
| DFW launch/compliance             | YELLOW  | Professional legal/tax/insurance/environmental/safety/privacy sign-offs are manual hard gates                                                                                                                         |
| Root-project license              | YELLOW  | Upstream notices/pins are recorded; StoryOps AI distribution license has not been selected                                                                                                                            |
| Deployment                        | YELLOW  | No deployment was requested or performed; TLS, secret manager, monitoring and rollback proof remain manual                                                                                                            |

## Non-negotiable manual launch gates

- Provision a reviewed hosted Supabase environment, configure public
  auth/redirect settings, apply the locked migrations, and run cross-role,
  offline-replay, Storage, and customer-portal canaries. The sandbox role
  selector must never be used as production identity.
- A trusted administrator must place the exact intended company UUID in a new
  owner's protected `app_metadata.storyops_bootstrap_company_id` invitation
  claim. After the owner invokes `complete_storyops_setup`, the administrator
  must verify its receipt/audit event and draft-disabled artifacts, remove the
  claim, and require a fresh session. Setup completion does not activate
  services, price books, terms, retention, providers, or launch authority.
- Store restricted credentials in a production secret manager and activate one
  provider at a time. For each provider, record validated callbacks/signatures,
  replay/duplicate behavior, current consent, rate/spend limits, timeout/retry
  behavior, authoritative reconciliation, kill switch, and one owner-approved
  low-risk canary. No such external canary has run.
- If photo-assisted automation is enabled, prove the private bucket, upload
  constraints, signed-URL expiry, content/malware operating process, reviewed
  model, uncertainty threshold, and human escalation with representative
  staged media.
- Complete an encrypted backup plus restore drill, including Storage if used,
  approve the retention/deletion schedule and legal-hold path, and record actual
  RPO/RTO.
- Complete every required sign-off in
  `docs/launch/DFW-LAUNCH-CHECKLIST.md` and adopt reviewed, site-specific
  safety/environmental/chemical SOPs using
  `docs/launch/EXTERIOR-CLEANING-SAFETY-CHECKLIST.md`.
- Establish production TLS, secrets manager, database/network restrictions,
  monitoring/alerts, on-call/incident ownership, privacy request channel,
  retention jobs, and deployment/rollback evidence.
- Choose and document the StoryOps AI root-project license before any
  distribution. Preserve `LICENSE.atomic-crm.md`, `NOTICE.md`,
  `THIRD_PARTY.md`, and `NPM_THIRD_PARTY_NOTICES.txt`.

## Release verification

The authoritative final command results, screenshot paths, package audit,
database verification, container evidence, backup proof, and commit provenance
are recorded in `BUILD_REPORT.md`. The machine-readable full proof is
`artifacts/demo-proof-final.json`. Do not change this verdict based on an
unrecorded local run.

Minimum required release commands:

```bash
npm ci
npm run licenses:check
npm run lint
npm run typecheck
npm run check:edge
npm test
npm run test:infra
npm run build
npm run test:e2e
npm run test:supabase -- --reset
npm run demo:proof -- --report artifacts/demo-proof-final.json --with-vroom
```

`npm run check:edge` requires Docker. Supabase release validation also requires
Docker:

```bash
npx --yes supabase@2.110.0 start
npm run test:supabase -- --reset
npx --yes supabase@2.110.0 stop
```

An error, skipped E2E run, missing browser, or unavailable required Docker
daemon remains **ERROR**, not GREEN. A provider with no real credential/canary
remains a manual **YELLOW** launch gate even when mocked contracts pass.

## Current operating rule

Until the manual gates above are signed, use StoryOps with synthetic data and
sandbox providers only. Supabase mode may be used against the local synthetic
stack for role/RLS/RPC verification. Keep every live enable flag false. AI may
draft, inspect, calculate through trusted server tools, and propose. The owner
retains legal, safety, chemical, environmental, insurance, tax, vendor, bank,
destructive, and live-customer commitments. Any uncertainty that affects
people, money, consent, scope, availability, or provider state stops the
affected action.
