# StoryOps AI

StoryOps AI is an AI-first service-business operating system. V1.1 runs one
company and ships its first complete industry pack for an owner-operated
exterior-cleaning business: pressure washing, soft washing, gutter/downspout
cleaning, roof washing, and window cleaning. The reusable kernel owns identity,
customers/properties, deterministic pricing, approvals, scheduling, field
execution, finance, provider truth, AI safety, and audit; the versioned pack
owns service-specific measurements, formulas, evidence, skills, equipment, and
operating guidance.

The repository is safe to run without credentials. Its default browser
workspace and every provider are sandboxed; no message, charge, calendar event,
route request, upload, or accounting mutation leaves the device.

> **Release status:** the no-key golden path, authenticated Supabase
> workspace/RPC path, domain rules, database/RLS model, AI policy layer, live
> server adapters, PWA, and verification suites are implemented. Sandbox mode
> persists only synthetic data in IndexedDB; Supabase mode uses magic-link
> authentication, a role-scoped workspace RPC, and a finite idempotent command
> RPC. No real credential, hosted deployment, or external provider canary was
> supplied or run. Treat [docs/STATUS.md](docs/STATUS.md) as the
> launch-readiness source of truth; implemented connectivity is not
> authorization to serve customers.

## What is implemented

- Responsive owner command center, pipeline, customer/property view, estimate
  workbench, dispatch board, offline-first field mode, finance, AI office,
  approvals, operations, integration health, audit trail, setup wizard, and
  customer portal.
- A reviewed company-configuration studio and versioned industry-pack contract.
  Setup creates drafts and requires separate publication; it never silently
  activates prices, terms, providers, outbound communication, or launch
  authority.
- Owner, dispatcher, technician, and customer permissions in application code
  and PostgreSQL row-level security.
- A versioned DFW price book and Decimal-based pricing engine for company and
  service minimums, square/linear footage, stories, surface, soil, access, risk,
  travel zones, add-ons, duration, cost, tax, deposits, discounts, and margin
  floors. Models do not calculate or invent prices.
- A bounded private scope-photo workflow with versioned required views,
  observations, confidence, unknowns, human-confirmed measurements, reviewer
  decisions, cleanup, and an exact estimate authorization bundle. A generic
  property photo cannot authorize an unrelated service or request.
- Capacity-, skill-, equipment-, weather-, and route-aware booking contracts.
- An AI office orchestrator with intake, estimating, scheduling, follow-up,
  marketing, finance, safety, and owner-briefing specialists; structured output;
  least-privilege tools; evidence grounding; injection defense; exact-payload
  approvals; tracing; idempotency; and bounded retry. Authenticated owners and
  dispatchers can run a bounded specialist or read-only owner briefing and read
  back its durable result; V1.1 does not claim an unattended scheduler.
- Sandbox provider implementations for OpenAI behavior, SMS/voice, email,
  payments, calendar, geocoding, weather, routing, optional signed Storage
  targets, and QuickBooks CSV export, plus opt-in server adapters for OpenAI,
  Twilio, HTTP email, Stripe, Google Calendar, Google Maps, NWS, VROOM,
  server-issued Supabase Storage targets, and QuickBooks CSV.
- Normalized signed lead intake for web/chat/email and Twilio-signed SMS/voice,
  plus verified Stripe/Twilio/email webhook reconciliation into durable domain
  state.
- Supabase migrations and a local-only seed covering the operational model,
  immutable audit events, approval/automation/AI evidence, provider-event
  claim/process/complete state, operation budgets, approved-action execution,
  idempotency claims, Storage policies, RLS, and role-specific mutation guards.
- An explicit customer quote-acceptance boundary requiring a typed signer and
  affirmative acknowledgement of the exact published quote version, terms
  version, and total. The append-only acceptance receipt is separate from
  inferred customer identity or a generic workspace command.
- An owner-only, bounded, redacted audit metadata feed. It never projects raw
  actor IDs or before/after payloads and is an operational view—not backup or
  cryptographic integrity proof.
- An owner-only company operational kill switch. A finite, idempotent,
  server-verified command moves only `active → paused` or `paused → active`,
  records the reason, receipt, and audit evidence, and cannot be replaced by a
  profile/settings update. While paused, the browser opens a minimal recovery
  workspace instead of projecting operational data.
- An authenticated estimate boundary that loads current human-verified
  measurements, operator classifications, the effective published price book,
  exact owner-reviewed ZIP-to-travel-zone mapping, scope-photo disposition,
  customer tax state, and an approved terms version on the server; unmapped or
  ambiguous ZIPs stop for review rather than falling back by fee or mileage. It
  then persists the estimate, lines, quote, provenance snapshot, idempotency
  receipt, and any exact owner approval in one transaction.
- A server-authoritative accepted-quote path for Stripe deposit checkout,
  provider-confirmed payment, capacity/weather/route-gated booking, field
  completion, and invoice issuance. Sandbox checkout remains explicitly unpaid
  until a verified payment event exists.
- Stripe Checkout Session (`cs_*`) and PaymentIntent (`pi_*`) identities remain
  distinct. Terminal failed/expired checkout attempts are retired before a
  replacement; late successes and amount/version conflicts quarantine verified
  funds, pause collection, and permit automatic ledger application only through
  an exact owner-approved current-balance resolver.
- Dockerized static runtime, optional pinned VROOM service, backup/restore
  scripts, health probes, runbooks, incident templates, and DFW launch/safety
  checklists.

## Quick start — no keys

Prerequisites for the no-key app are Node `22.22.3` (see `.nvmrc`) and npm.
Docker is additionally required for the pinned Edge typecheck. From the
repository root, the setup-and-core-verification command copies `.env.example`
to an owner-only `.env.local`, installs the locked dependency graph when
needed, validates sandbox configuration, and runs the license, lint, type,
Edge, unit, infrastructure, and production-build checks:

```bash
npm run setup:app -- --verify
```

Playwright and the local Supabase release contract remain explicit because
they require installed Chromium and a reviewed local database/network posture;
run them from the verification section below.

Without Docker, run `npm run setup:app` for setup/configuration validation and
use `npm run dev`; report the Docker-backed Edge gate as unverified rather than
passing it.

Start the application:

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. The seeded workspace is synthetic. Use **Reset
sandbox** in the UI, or clear the `storyops-ai` IndexedDB database, to return to
the starting state.

`make setup` is the shorter setup-only alias. It does not run verification.

### Optional local Supabase

A running Docker daemon is required:

```bash
npm run setup:app -- --with-supabase
```

Every repository script invokes the exact `supabase@2.110.0` package through
`npx`; an installed global CLI is deliberately ignored. After `supabase start`,
setup inspects every project container's published Docker bindings. It fails if
any port is exposed beyond `127.0.0.1`/`::1` and stops the stack when that
invocation just started it. Fix the Docker binding before continuing. The
explicit
`--unsafe-allow-wildcard-supabase-ports` override accepts local-network
exposure and is only for an operator who has reviewed that risk.

To start Supabase and run the core verification subset plus the live local
Supabase release contract without rebuilding the database:

```bash
npm run setup:app -- --with-supabase --verify
```

Database reset is destructive to local Supabase data and is never implicit in
that setup command. Request it explicitly when a clean fixture database is
intended:

```bash
npm run setup:app -- --with-supabase --verify --reset-supabase
```

Equivalent lifecycle commands are:

```bash
make supabase-start
make supabase-reset
make supabase-stop
```

`supabase db reset --local` applies every
ordered migration under `supabase/migrations` and then `supabase/seed.sql`.
The seed is for local development only and must never be applied to a hosted
project. Its `terms-v1` service terms are synthetic fixtures whose review
reference is explicitly local-sandbox-only; they are not legal advice and
cannot satisfy the production terms/legal launch gate.

Live dispatch additionally requires `pg_cron`. Migration `20260728610000`
registers exactly one `storyops-dispatch-origin-purge` job at a five-second
cadence. Launch and departure fail closed unless **Integrations** observes a
recent scheduler-owned success, zero retention backlog, exact ACLs, and healthy
worker state; calling the cleanup function manually is not health proof. The
worker prunes only its own history older than 24 hours in bounded batches.
Recovery re-registers the job and waits for a real scheduled run. See the
[pilot operator runbook](docs/runbooks/PILOT_OPERATOR_RUNBOOK.md#dispatch-origin-retention-scheduler)
for recovery and the disclosed `UNLOGGED`/MVCC/provider-retention limits.

Local seed identities use the password `StoryOpsDemo1!`:

| Role       | Local email                 |
| ---------- | --------------------------- |
| Owner      | `owner@storyops.local`      |
| Dispatcher | `dispatcher@storyops.local` |
| Technician | `technician@storyops.local` |
| Customer   | `customer@storyops.local`   |

These identities exercise the Supabase API/RLS model. To use the browser’s
authenticated path, set `VITE_STORYOPS_DATA_MODE=supabase` and provide the local
public Supabase URL, public anon key, and seeded company UUID through the
`VITE_` settings documented in `.env.example`; never use the service-role key.
The app then presents magic-link sign-in, derives the role from the active
membership, and loads `get_storyops_workspace`. Ordinary finite workspace
mutations use `execute_storyops_command`; media finalization, first-company
setup, deterministic estimating, golden-path transitions, post-service work,
and provider reconciliation use narrower authenticated or service-only RPC/
Edge boundaries. In particular, the generic command RPC rejects
`media.register`.

On a pristine non-seeded deployment, an owner may complete first-company setup
only when Auth `app_metadata.storyops_bootstrap_company_id` exactly matches the
configured public company UUID. The browser calls the read-only
`get_storyops_setup_state` and guarded `complete_storyops_setup` RPCs; see
[`docs/runbooks/LIVE_SETUP_RUNBOOK.md`](docs/runbooks/LIVE_SETUP_RUNBOOK.md).
The resulting company remains in `setup`: ordinary workspace reads/writes and
provider starts remain closed until the owner separately publishes a reviewed
live configuration and the exact operating baseline changes it to `active`.
Setup completion alone is never an operational or launch-ready state.

### Company pause and recovery

In authenticated Supabase mode, a signed-in owner with an active membership can
use **Company control** to pause or reactivate operations. The UI requires a reason and exact typed
confirmation; the server binds the expected/target status, normalized reason,
canonical request, SHA-256 hash, actor, and stable command ID. Same-command
replay returns its receipt, while stale status or changed-payload reuse fails
closed. Dispatchers, technicians, customers, service credentials, generic
workspace commands, and direct company-profile writes cannot operate this
control.

Pausing is a company-wide server gate, not a navigation toggle. New
operational mutations, provider-call starts, automation starts, field evidence
finalization, Storage writes, and fresh scope-photo signed upload targets are
blocked. Already accepted provider callbacks/retrieval can still reconcile;
bounded failure recording, retention work, and scope-photo orphan cleanup stay
available so external truth and cleanup evidence are not lost. A pause does not
retroactively revoke an already-issued short-lived upload token, so keep its
expiry short; the paused company still cannot finalize/register the object, and
the expired reservation can be cleaned through the trusted orphan worker.

Pending offline command/media packets do not prevent the owner from engaging
the kill switch and are not deleted. Recovery shows only packet kind, status,
and creation time plus the last server-verified time and current recovery
error—never command payloads, entity IDs, photo bytes, or signature data.
Packets cannot sync while paused. Reactivate only after review, reload the full
server workspace, and then reconcile the original idempotent queue. Reactivation
does not authorize launch or enable any provider.

Authenticated Supabase mode also makes the private `job-media` bucket and
`field-media-finalize` Edge function mandatory core data-plane dependencies.
Field capture uploads through user RLS, reads the exact object back, verifies
its bytes, and registers evidence only through that trusted finalizer. Failure
at any stage remains visible and blocks completion. This path is not controlled
by the optional `SIGNED_STORAGE_TARGETS_*` provider switches. Sandbox data mode
does not call Supabase Storage.

### Optional routing service

```bash
npm run setup:app -- --with-routing
```

This builds VROOM `v1.15.0` and vroom-express `v0.12.0` from exact commits and
without GLPK. Deterministic custom-matrix requests work without a routing key.
Coordinate routing additionally requires an operator-approved OSRM, ORS, or
Valhalla service; one is not bundled.

## Golden path

The Playwright suite traverses this sequence in desktop and mobile projects;
domain/unit tests separately prove the pricing, booking, approval, permission,
idempotency, and provider-security contracts:

1. qualify a multi-channel lead from verified contact, consent, address, and
   scope facts;
2. review photo evidence and explicit unknowns;
3. calculate an estimate from a published price-book version;
4. route a large discount to an owner approval bound to the exact payload;
5. publish an approved quote to the customer portal and accept it; quote
   publication is not email/SMS delivery evidence;
6. book only after capacity, weather, and route checks;
7. complete the mobile visit checklist, timer, materials, before/after photos,
   notes, and signature, including an offline packet whose original media,
   hashes, commands, and completion intent reconcile in dependency order;
8. issue an invoice and record an explicitly synthetic local paid-state
   fixture; no funds move and no provider payment is asserted; and
9. request a review and activate recurring maintenance.

In local Supabase mode, `estimate-workflow` proves the server-owned estimate
slice: back-office identity, exact measurement evidence, current terms and price
book, deterministic pricing, stable idempotent replay/conflict, owner approval,
and quote publication to the eligible portal projection. The `golden-path`
boundary then proves accepted quote through
invoice without treating sandbox or provider-accepted state as payment.
The dedicated-token `post-service-worker` keeps the service role internal while
leasing due review, referral, and recurring-maintenance messages. It rechecks the exact current marketing
consent immediately before submission, and uses the provider adapters with a
stable StoryOps correlation key. Before a live Twilio create call it commits a
fail-safe `submitted_unknown` boundary; an ambiguous result is excluded from
automatic resend and requires provider reconciliation, while a returned
authoritative SID advances to `submitted` until callback/poll delivery
reconciliation. A later provider read failure is not a provider delivery
failure: bounded read retries that exhaust leave the known live receipt
`submitted` with `RECONCILIATION_EXHAUSTED`, preserve the provider/message
identity and last provider status, require manual reconciliation, and remain
ineligible for automatic resend. A signed callback may still resolve that
receipt. Transactional quote and on-my-way attempts are serialized per company
and business entity across channels, so changing SMS to email cannot create a
second active customer contact. Live post-service marketing email is intentionally disabled
until a signed unsubscribe/suppression path is implemented. In the no-key path
the durable result is explicitly `sandboxed`; the communication record remains
queued and does not claim that a customer was contacted.

Run it with:

```bash
npm run test:e2e
```

The role selector exists only in synthetic sandbox mode. Supabase mode does not
accept a client-selected role; durable authorization comes from Supabase Auth,
active memberships, RLS, assignment checks, and server-side policy.

## Architecture

```text
React/Vite PWA
  ├─ sandbox workspace: IndexedDB + idempotent offline outbox
  ├─ authenticated workspace: Supabase Auth + role-scoped read/command RPCs
  ├─ deterministic domain: pricing, booking, policy, evidence, RBAC
  └─ server boundaries
       ├─ Supabase Postgres/Auth/Storage/RLS + Edge Functions
       ├─ guarded AI office + OpenAI Agents SDK adapter
       ├─ typed provider contracts + sandbox/live adapters
       ├─ MCP read/sandbox tools
       └─ VROOM route optimizer
```

The main boundaries are:

- `src/domain`: business entities, role permissions, evidence, and booking
  contracts;
- `src/core/pricing`: Decimal-only deterministic calculations;
- `src/core/policy`: auto-execute, approval, and deny decisions;
- `src/core/ai`: structured specialist orchestration and guardrails;
- `src/core/integrations`: provider contracts, sandbox ledgers, consent,
  rate limits, reconciliation, and server/public live adapters;
- `src/state`: sandbox repository, authenticated Supabase repository, and
  user/company-scoped offline outbox;
- `supabase`: durable schema, RLS, seed, and server-side Edge boundaries;
- `mcp`: least-privilege health, content inspection, and sandbox-run surface;
  and
- `infra` / `scripts`: production static runtime, VROOM, setup, health,
  backup, restore, and executable proof.

See [docs/SOURCE_OF_TRUTH.md](docs/SOURCE_OF_TRUTH.md) for authority and change
rules, [docs/architecture/AI_OFFICE.md](docs/architecture/AI_OFFICE.md) for the
AI control plane, and
[docs/architecture/INTEGRATIONS.md](docs/architecture/INTEGRATIONS.md) for
provider semantics.

## Real providers versus sandbox

Every real provider call requires both its provider-specific `*_MODE=live` and
its explicit `*_LIVE_ENABLED=true` (or the V1 export enable flag). Either switch
alone is fail-closed. `*_MODE=disabled` disables sandbox behavior as well. A
server-side adapter, required secrets, successful health check, reconciliation
procedure, owner approval, and provider-specific launch evidence are all
required.

| Capability       | Default proof                                       | Implemented live boundary / remaining YELLOW gate                                                                                            |
| ---------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI           | Deterministic structured sandbox result             | Node/Edge Agents SDK; explicit enable, credentials, evals, spend canary pending                                                              |
| Twilio SMS/voice | Consent/rate/idempotency sandbox ledger             | Server sends + signed callbacks; owned numbers, registration, legal review, canary pending                                                   |
| Email            | Consent-checked sandbox ledger                      | Token-authenticated HTTPS adapter + signed delivery callback; domain/provider canary pending                                                 |
| Stripe           | Sandbox checkout/invoice/payment/refund artifacts   | Checkout/Invoicing/refund + signed reconciliation, retired attempts, collection holds, exact approved allocation; account/tax/canary pending |
| Google Calendar  | Deterministic sandbox availability and entries      | Allowlisted calendar, OAuth refresh, free/busy, holds/bookings; OAuth canary pending                                                         |
| Maps/geocoding   | Low-confidence synthetic DFW point marked `unknown` | Validated Google Maps adapter; restricted key, quota, precision canary pending                                                               |
| NWS weather      | Explicit unknown forecast; no invented conditions   | Read-only NWS adapter; monitored User-Agent and operational canary pending                                                                   |
| VROOM routing    | Deterministic sandbox plan/custom matrix            | Validated HTTP adapter; private engine/backend and route acceptance pending                                                                  |
| Core field media | IndexedDB/local sandbox packet; zero Storage calls  | Mandatory with Supabase data mode: private RLS upload/read-back + byte-verifying trusted finalizer; hosted device canary pending             |
| Signed targets   | `sandbox://` targets                                | Optional server-issued upload/download targets gated by `SIGNED_STORAGE_TARGETS_MODE` + `SIGNED_STORAGE_TARGETS_LIVE_ENABLED`                |
| QuickBooks       | Checksummed, reviewable CSV                         | Manual import only; no OAuth posting, vendor action, or bank mutation                                                                        |

Read `.env.example` and
[docs/compliance/PROVIDER-BOUNDARIES.md](docs/compliance/PROVIDER-BOUNDARIES.md)
before activating anything. `VITE_` variables are public build inputs and must
never contain secrets. In Supabase mode the health screen calls an authenticated
owner/dispatcher-only Edge probe protected by a durable per-user budget. Its
signed-target card is an optional provider check, not field-media readiness;
the UI shows the mandatory core data plane separately. Sandbox health and
compiled adapters are not evidence that any external provider canary passed.

## AI safety model

External text, transcripts, OCR, photos, reviews, and retrieved prose are data,
never instructions. A specialist can only propose tools in its allowlist.
The AI Edge boundary never accepts client-supplied fact values as truth. A
bounded root selector contains an ID only; the server reloads the permitted
company-owned record and relationships. Its `pricing.calculate` tool accepts
only a stored estimate ID, reloads the active price book and human-verified
measurements, and rejects any total drift. Trusted code validates structured
output, source IDs, permissions, pricing/SOP compliance, risk, reversibility,
idempotency, and exact-payload approvals before any side effect.

Only grounded, low-risk, reversible, idempotent allowlisted actions may be
eligible for automatic execution. V1.1 does not activate an unattended
scheduler: an owner or dispatcher deliberately starts each AI Office run.
Price exceptions, discounts above policy, refunds, legal/safety messages,
negative-review replies, campaign sends, vendor/bank actions, destructive
changes, and work outside published price books/SOPs require approval or remain
human-only. V1.1 includes separate exact approved-action executors for Stripe
refunds and the supported AI lead mutations. Both revalidate current state
under an atomic execution lease. Other sensitive actions remain
unexecuted/manual until they receive an equally constrained server executor.

AI must never invent measurements, prices, availability, payment state,
regulations, chemical/safety instructions, or provider success.

## Roles

| Role       | Intended scope                                                                  |
| ---------- | ------------------------------------------------------------------------------- |
| Owner      | Company/policy, price books, integrations, approvals, payments, audit, all work |
| Dispatcher | Leads, properties, estimates, dispatch, invoices, communications, operations    |
| Technician | Assigned job/visit execution, materials read, incident reporting                |
| Customer   | Own portal records, quote acceptance, jobs, invoices, payments                  |

Application permissions live in `src/domain/roles.ts`; database enforcement
lives in the migration. Server code must enforce both authenticated identity and
company/assignment scope. UI route hiding is not an authorization boundary.

## Verification

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
```

The final command is the required local live-data proof. It rebuilds every
ordered migration and the synthetic seed, runs database lint and every SQL
security/workflow contract, starts the local Edge worker, and exercises the
authenticated estimating flow, affirmative acceptance/audit boundaries,
payment-allocation and retired-checkout contracts, durable post-service worker,
and actual-byte offline-field media
upload/tamper/overwrite/replay/dependent-completion integration. This is local
proof—not a hosted or physical-device canary—and it prints no local keys.
It also exercises real Supabase CLI schema and data artifacts: the data dump
uses exactly the `auth`, `public`, and `private` schemas, excludes `storage` and
`cron` by that allowlist, and explicitly omits the three private
dispatch-origin transient tables.

The executable proof runs the no-key prerequisite check, backup dry run, infra
tests, lint, typecheck, unit/integration tests, production build, and both
Playwright projects, then writes a machine-readable report:

```bash
npm run demo:proof
```

The default command writes a uniquely timestamped report. To choose a path, use
a new filename; the proof runner refuses to overwrite existing evidence:

```bash
npm run demo:proof -- --report artifacts/demo-proof-$(date +%Y%m%d-%H%M%S).json
```

`--quick` or `--skip-e2e` produces an explicitly partial proof. It must not be
reported as a full golden-path result.

## Production-like static runtime

```bash
docker compose --env-file .env.local up --build app
curl --fail http://127.0.0.1:8080/healthz
```

Compose intentionally has no implicit data-mode fallback: always pass the
reviewed `.env.local` explicitly. A `supabase` build fails unless its public
Supabase URL, anon key, and company UUID are all present; a `sandbox` build
requires no credentials. Set `STORYOPS_BUILD_REVISION` to the reviewed source
revision for a release image. `/healthz` reports the non-secret compiled
`dataMode` and `revision`, and runtime startup fails when the compiled mode does
not match the expected mode supplied by Compose. That prevents an artifact
built for one data boundary from being started as another.

The container runs as a non-root user with a read-only filesystem, dropped
capabilities, `no-new-privileges`, loopback-only host publishing, security
headers, SPA fallback, and structured request logs. It serves the static PWA;
it does not host Supabase or server-side provider secrets. Terminate TLS and
run server/Edge workloads in reviewed infrastructure before any live launch.

## Backup, restore, and incidents

- Backup: `npm run backup -- --local`
- Safe restore validation:
  `npm run restore -- --backup /absolute/path --dry-run --local`
- Recovery-grade database dumps allow exactly `auth`, `public`, and `private`
  data. Storage and cron data are excluded by that schema allowlist, while
  `private.dispatch_current_origin_ephemera`,
  `private.dispatch_current_origin_verifiers`, and
  `private.dispatch_origin_purge_worker_health` are explicit table exclusions.
- Backup source evidence and restored-target verification must each report zero
  `service_role` DML and related table-data privileges on `public` base tables.
- External health probe: `node infra/observability/health-check.mjs`
- Detailed recovery:
  [docs/compliance/BACKUP-RESTORE.md](docs/compliance/BACKUP-RESTORE.md)
- Incident response:
  [docs/incidents/AI_INTEGRATION_INCIDENT_PLAYBOOK.md](docs/incidents/AI_INTEGRATION_INCIDENT_PLAYBOOK.md)

Backups contain sensitive customer data and are not encrypted by the script.
Production operators must encrypt off-site copies, protect credentials, honor
legal holds, and prove restores.

## Documentation map

| Read this                                                                                                    | When                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| [Build report](BUILD_REPORT.md)                                                                              | Reading final architecture, flow, verification, image, and handoff evidence             |
| [Pilot readiness report](PILOT_READINESS_REPORT.md)                                                          | Separating local rehearsal readiness from live-launch gates                             |
| [Source of truth](docs/SOURCE_OF_TRUTH.md)                                                                   | Deciding which record, rule, or document controls                                       |
| [Current status](docs/STATUS.md)                                                                             | Before planning work, testing, or considering launch                                    |
| [Current owner briefing](docs/briefings/CURRENT.md)                                                          | Reading the current read-only owner summary                                             |
| [Admin guide](docs/ADMIN_GUIDE.md)                                                                           | Operating the company and approval/provider controls                                    |
| [Developer guide](docs/DEVELOPER_GUIDE.md)                                                                   | Changing code, schema, policies, adapters, or tests                                     |
| [AI office architecture](docs/architecture/AI_OFFICE.md)                                                     | Changing agents, tools, traces, injection defense, or approvals                         |
| [Industry-pack architecture](docs/architecture/INDUSTRY_PACKS.md)                                            | Adding or changing a supported service vertical                                         |
| [Integration architecture](docs/architecture/INTEGRATIONS.md)                                                | Connecting or reconciling a provider                                                    |
| [Pilot operator runbook](docs/runbooks/PILOT_OPERATOR_RUNBOOK.md)                                            | Rehearsing and signing the bounded first-pilot operating record                         |
| [AI office runbook](docs/runbooks/AI_OFFICE_RUNBOOK.md)                                                      | Daily/weekly AI operations                                                              |
| [Integration runbook](docs/runbooks/INTEGRATION_RUNBOOK.md)                                                  | Health checks, activation, outages, and reconciliation                                  |
| [Authenticated setup runbook](docs/runbooks/LIVE_SETUP_RUNBOOK.md)                                           | Inviting and verifying a protected first owner                                          |
| [Identity provisioning runbook](docs/runbooks/IDENTITY_PROVISIONING.md)                                      | Inviting, changing, offboarding, and reconciling identities                             |
| [Scheduling reconciliation](docs/runbooks/SCHEDULING_RECONCILIATION.md)                                      | Resolving route, weather, calendar, resource, and orphan evidence                       |
| [Scope-photo evidence runbook](docs/runbooks/SCOPE_PHOTO_EVIDENCE.md)                                        | Requesting, reviewing, retaining, and cleaning private scope media                      |
| [Provider boundaries](docs/compliance/PROVIDER-BOUNDARIES.md)                                                | Credentials, consent, webhook, and provider-specific gates                              |
| [Backup/restore](docs/compliance/BACKUP-RESTORE.md)                                                          | Protecting or recovering data                                                           |
| [Retention/privacy](docs/compliance/DATA-RETENTION-AND-PRIVACY.md)                                           | Classifying, retaining, exporting, or deleting data                                     |
| [Incident playbook](docs/incidents/AI_INTEGRATION_INCIDENT_PLAYBOOK.md)                                      | Containing AI/provider, payment, consent, or data incidents                             |
| [Field safety/environment incident playbook](docs/incidents/FIELD_SAFETY_ENVIRONMENTAL_INCIDENT_PLAYBOOK.md) | Stopping work and containing injury, chemical, runoff, property, or equipment incidents |
| [Approval template](docs/templates/APPROVAL_RECORD.md)                                                       | Recording exact-payload decisions outside the product                                   |
| [Incident template](docs/templates/INCIDENT_REPORT.md)                                                       | Capturing timeline, impact, evidence, and corrective actions                            |
| [Reconciliation template](docs/templates/PROVIDER_RECONCILIATION.md)                                         | Matching provider and local state by stable IDs                                         |
| [Owner briefing template](docs/templates/OWNER_BRIEFING.md)                                                  | Producing a sourced, read-only owner brief                                              |
| [DFW launch checklist](docs/launch/DFW-LAUNCH-CHECKLIST.md)                                                  | Preparing Texas/DFW launch                                                              |
| [Field safety checklist](docs/launch/EXTERIOR-CLEANING-SAFETY-CHECKLIST.md)                                  | Adopting SOPs and preparing every visit                                                 |
| [Next V1.2 goal prompt](NEXT_GOAL_PROMPT.md)                                                                 | Proving the reusable kernel with residential cleaning                                   |

The launch and safety documents cite official sources but are not legal,
medical, tax, environmental, insurance, or safety advice. Every item marked
**REQUIRED LEGAL REVIEW** or equivalent is a hard launch gate.

## Licensing

Atomic CRM’s MIT notice is preserved in `LICENSE.atomic-crm.md`. Exact upstream
pins and usage boundaries are in [THIRD_PARTY.md](THIRD_PARTY.md).
OCA/field-service was used only as an AGPL-licensed domain checklist; no OCA
code was copied. StoryLand’s operating patterns were independently
reimplemented; no StoryLand code or text was copied. Transitive npm notices are
generated in `NPM_THIRD_PARTY_NOTICES.txt`; the separately locked VROOM runtime
graph is captured in
`infra/vroom/runtime-package/NPM_THIRD_PARTY_NOTICES.txt` and that exact
inventory is copied into the routing image. StoryOps AI itself has no release
license selected in this repository; choosing and documenting the root-project
license is a manual YELLOW gate before distribution.
