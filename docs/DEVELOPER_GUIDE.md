# StoryOps AI developer guide

**Audience:** engineers changing application, data, AI, integration, or
operations controls  
**Status:** V1  
**Last reviewed:** 2026-07-28

Read [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md) and
[STATUS.md](STATUS.md) before changing behavior. A green unit test cannot
authorize a business commitment that lacks its controlling source or reviewer.

## Local development

Use the exact Node version:

```bash
nvm use
npm ci
cp -n .env.example .env.local
npm run dev
```

Or use the guarded one-command setup:

```bash
npm run setup:app -- --verify
```

Do not add secrets to `.env.example`. All `VITE_` values are browser-visible.
Tests and local UI must remain fully functional with every provider in
`sandbox`.

## Repository layout

| Path                    | Responsibility                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `src/domain`            | Branded primitives, entities, roles, evidence, booking, governance                              |
| `src/core/pricing`      | Decimal deterministic estimate engine and result contracts                                      |
| `src/core/policy`       | Permissions, risk, guardrails, auto/approval/deny decisions                                     |
| `src/core/ai`           | Specialist roster, schemas, tools, approvals, security, trace, retry                            |
| `src/core/integrations` | Provider contracts, sandbox/live adapters, consent, budgets, reconciliation                     |
| `src/state`             | Sandbox and Supabase repositories, projections, scoped IndexedDB/outbox                         |
| `src/pages`             | Responsive product and portal views                                                             |
| `supabase/migrations`   | Authoritative durable schema, RLS, triggers, RPCs, Storage policy                               |
| `supabase/functions`    | Setup support, AI/action/health, intake/webhooks, post-service worker, field-media finalization |
| `mcp`                   | Least-privilege MCP server and OpenAI Agents adapter                                            |
| `infra`                 | Static runtime, VROOM build/config, health and process utilities                                |
| `scripts`               | Setup, executable proof, backup, and guarded restore                                            |
| `tests/unit`            | Domain, pricing, policy, AI, integration, and UI contract tests                                 |
| `tests/integration`     | Infrastructure script/security tests using Node’s test runner                                   |
| `tests/e2e`             | Desktop/mobile golden path, roles, approval, idempotency, offline recovery                      |

## Core engineering invariants

- Use `decimal.js` for every calculation. Money and rates cross boundaries as
  validated decimal strings; never use JavaScript floating point for totals.
- An estimate cites an immutable price-book version, measurement/evidence IDs,
  calculation version, and deterministic input/result snapshot.
- Live estimate intent and its authoritative snapshot are hashed separately.
  Ambiguous client retries retain the same idempotency key; a material intent
  change or confirmed receipt rotates it.
- A model cannot supply a price, payment state, availability, permission,
  company ID, approval decision, regulation, or safety/chemical instruction.
- Treat customer/provider/photo/OCR/retrieved text as untrusted data. Preserve
  unknowns and reject instruction-shaped content before tools.
- Every tool has least-privilege input/output schemas, authenticated context,
  server-side capability metadata, idempotency semantics, timeout, and
  redacted trace.
- Auto-execution is limited to grounded, low-risk, reversible, idempotent,
  allowlisted actions. Sensitive actions require an exact-payload approval.
- Same idempotency key/same canonical request returns the stored response; same
  key/different request is a conflict.
- Provider `accepted`, queued, unknown, or sandbox responses never become live
  success.
- Authorization is server-side membership/assignment/RLS. React route guards
  are usability only.
- Published price books and audit events are append-only. Correct forward with
  a new version/event.
- The application must remain useful with no keys and fail closed when live
  configuration or provider truth is missing.

## Verification

Fast release check:

```bash
npm run verify
```

Full local proof:

```bash
npx playwright install chromium webkit
npm run demo:proof
```

The proof runner writes a unique timestamped artifact by default and refuses to
overwrite evidence. Use a new `--report` filename when a stable path is needed.

Individual gates:

```bash
npm audit --audit-level=high
npm run install:vroom-runtime
npm audit --prefix infra/vroom/runtime-package --audit-level=high
npm run licenses:check
npm run lint
npm run typecheck
npm run check:edge
npm test
npm run test:infra
npm run build
npm run test:e2e
npm run format:check
```

`npm run check:edge` uses the pinned `denoland/deno:2.5.6` image, frozen
`supabase/functions/deno.lock`, and explicit Edge entrypoint list in
`scripts/check-edge.mjs`; it requires Docker. `npm test` runs Vitest unit/UI
tests; the `.mjs` infrastructure suite is a separate Node test command.
Playwright runs serial desktop Chromium and iPhone 14-sized projects against a
production build/preview server.

Do not describe `--quick`, `--skip-e2e`, a single project, or a reused stale
server as full proof. Preserve failing traces/screenshots/videos.

## Supabase development

Start/reset/lint the pinned local stack:

```bash
npm run setup:app -- --skip-install --with-supabase
npx --yes supabase@2.110.0 db reset \
  --local \
  --network-id storyops-ai-supabase-loopback
npx --yes supabase@2.110.0 db lint \
  --local \
  --schema public \
  --level warning \
  --fail-on error
```

Stop it with:

```bash
npx --yes supabase@2.110.0 stop \
  --no-backup \
  --network-id storyops-ai-supabase-loopback
```

The setup boundary creates and validates a bridge whose published ports bind
to loopback, then inspects every project container. Do not replace it with a
plain `supabase start`; a loopback API URL alone does not prove Docker listener
isolation. Also do not print `supabase status -o env/json` in logs because it
contains local signing and service-role credentials.

Migration rules:

- add a new timestamped migration; never rewrite an applied production
  migration;
- scope every tenant-owned table by `company_id` and enable RLS;
- create explicit select/insert/update/delete policies;
- test owner, dispatcher, assigned/unassigned technician, customer-own, other
  customer, and anonymous/service boundaries;
- constrain technician/customer mutable columns with triggers when an update
  policy alone is too broad;
- keep audit events append-only and security-definer functions locked to an
  intentional `search_path`;
- revoke broad function/table privileges before granting exact roles; and
- seed only synthetic local data. Never copy customer data into CI/local.

The ordered files in `supabase/schemas` mirror the corresponding timestamped
migrations for inspection; the timestamped migrations are deployment
authority. Keep each pair synchronized—never let two divergent schemas appear
authoritative.

The React data layer has two explicit implementations:

- sandbox mode uses synthetic `DemoState` and IndexedDB and must make zero
  Supabase Storage requests;
- Supabase mode uses magic-link Auth, validates the configured public URL/anon
  key/company UUID, loads `get_storyops_workspace`, maps only the server’s
  role-specific projection, and sends ordinary finite workspace mutations
  through `execute_storyops_command`. First-company setup, media finalization,
  estimating, golden-path transitions, post-service work, approved refunds,
  ingress, and provider reconciliation use narrower RPC/Edge boundaries.

The command RPC derives actor/role from Auth, rechecks membership/assignment,
uses optimistic versions, and atomically reserves the browser-generated command
ID/request hash. The offline queue preserves that exact command, scopes cached
state to user/company, and purges client persistence on sign-out or identity
change. Visit media and typed completion signatures are captured as Blob bytes
in the same scoped IndexedDB packet with stable asset UUIDs, local SHA-256
hashes, exact finalization work, and explicit dependencies. Replay uploads
without overwrite and reads the private object back. Registration calls
the authenticated `field-media-finalize` Edge boundary, which independently
downloads and hashes the actual stored bytes before its service-only RPC can
consume a one-time checksum attestation and insert metadata. Direct
authenticated `media.register`, media/signature DML, and object overwrite fail
closed. The completion transition stays pending—not optimistically
complete—until every prerequisite is durably confirmed.

Do not gate this core path with the optional provider switches. Setting
`VITE_STORYOPS_DATA_MODE=supabase` makes the private bucket/RLS/finalizer
mandatory. `SIGNED_STORAGE_TARGETS_MODE` and
`SIGNED_STORAGE_TARGETS_LIVE_ENABLED` control only the separate server-issued
signed-target adapter shown in provider health. Hosted Auth redirects, realtime
needs, revoked-session behavior, device controls, media recovery, and
end-to-end staging canaries must be proved before production launch.

A pristine live setup is not a generic workspace command. The browser first
reads `get_storyops_setup_state`, then calls
`complete_storyops_setup`; that function requires an exact
`app_metadata.storyops_bootstrap_company_id` match and creates only the guarded
initial company/owner/draft configuration described in the live setup runbook.

## Extending pricing

1. Add/version the service/catalog and price-book rules; do not branch on
   customer prose.
2. Require explicit quantities, units, attributes, measurement source IDs, and
   evidence disposition.
3. Implement Decimal formula changes in `src/core/pricing`.
4. Return issues/approval flags instead of guessing a missing rule.
5. Add fixtures for exact cents, boundaries, taxability, minimum, discount,
   margin, duration, inactive/effective versions, and missing values.
6. Record a new calculation version and comparison evidence.

The LLM-facing Edge tool accepts only a stored estimate ID. It reloads the
company-owned active price book/rules, stored calculation input, estimate-line
source IDs, human-verified property measurements, customer tax status, and
photo disposition, recalculates with the Decimal engine, and rejects total
drift. Do not weaken this into model-supplied amounts, quantities, attributes,
or price-book data.

## Extending the AI office

1. Decide whether a deterministic workflow is sufficient; use a model only for
   language/evidence synthesis.
2. Add the typed tool name and strict Zod input/output schema.
3. Give it the narrowest authenticated repository/provider capability.
4. Add it only to the specialist allowlists that need it.
5. Define authoritative risk, reversibility, idempotency, retryability, and
   approval category outside the model.
6. Add structured-output validation, protected-claim semantic grounding, and
   trace redaction. Merely checking that a cited fact ID exists is not
   grounding: bind each factual claim class to the matching fact domain and
   exact asserted values. Keep summary/draft prose non-authoritative and
   customer drafts structurally blocked from automatic send.
7. Test success, malformed output, nonexistent source ID, injection, wrong
   specialist, wrong role/company, approval/mismatch/expiry/replay, transient
   retry, and indeterminate provider state.
8. Update AI architecture, runbook, status, and release evidence.

OpenAI Agents SDK code belongs in server adapters. Do not import it or provider
keys into browser components.

The `ai-office` Edge function treats the browser fact list as a request shape,
not evidence: it loads company facts server-side and supplies only those values
to the orchestrator. It also consumes durable per-user, per-company, and daily
token-reservation budgets before model execution. Client fields must never
expand the server fact set, company, role, tool registry, or spend limit.

An approved external action needs its own server executor. V1 implements only
`payments.refund` in `ai-approved-action`: owner membership, persisted approval
hash/expiry/status, specialist/tool metadata, payment eligibility, amount,
atomic execution lease, provider idempotency key, output schema, durable
completion, and replay are all revalidated. Adding another tool requires the
same end-to-end contract; approval status alone is never executable authority.

## Adding a provider

Implement the interface in `src/core/integrations/contracts.ts` and preserve:

- explicit `sandbox | live | disabled` mode and health response;
- server-only credentials with missing-variable names but never values;
- validated request/response types, stable provider IDs, and `AbortSignal`;
- consent/opt-out/quiet-hour controls where applicable;
- rate limits, bounded retry, and non-retryable validation/auth conflicts;
- idempotency request hashing and provider-event deduplication;
- signature validation over the required raw body/canonical URL before parse;
- claim/start/reconcile/complete/fail processing with a finite redacted receipt;
- authoritative retrieval/reconciliation after timeouts or ambiguous results;
  and
- sandbox receipts that say `mode: "sandbox"` and never resemble live success.

Add contract/security tests and update the integration architecture, provider
boundary, environment template, health screen source, runbook, and status.
Presence of an API key must not silently activate a provider.

The normalized lead-ingress contract is separate from provider status
callbacks. Signed web/chat/email events and Twilio SMS/voice requests validate
body bounds, event time, company, sender/contact shape, consent assertions,
rate limits, event/hash deduplication, and idempotency before persisting the
lead, communication, and consent records. Stripe/Twilio/email callbacks use the
provider reconciliation parser and service-only database RPC; never replace
either path with generic unverified JSON ingestion.

## Offline changes

An offline mutation needs a stable entity/action, canonical payload, generated
idempotency key, local creation time, dependency IDs, attempt evidence, and
explicit queued/syncing/synced/failed state. Media mutations additionally retain
the original Blob, byte count, MIME type, object path, asset UUID, and SHA-256
hash. The server owns authorization, current-version conflict detection, and
the durable response. A client must not discard or rewrite a queued mutation to
make sync appear successful; confirmed dependencies remain in the packet when a
later command fails so retry can skip the already-reconciled upload. Unsupported
live mutations must remain visibly blocked/read-only instead of silently
editing the cached projection.

Test process restart, repeated sync, same-key conflict, role/access revocation,
record version conflict, partial attachment upload, provider timeout, and
eventual reconciliation.

## MCP

Run the local server:

```bash
npm run mcp
```

The V1 MCP surface exposes integration health, untrusted-content inspection,
and a no-side-effect sandbox AI run. Keep schemas strict and capabilities
read-only/sandbox unless a future authenticated, policy-enforced mutation has
its own approval and idempotency tests. MCP clients never receive server
secrets.

## Infrastructure and security

- The Docker app image is a static PWA server; server integrations belong in
  Supabase Edge or another reviewed backend.
- Keep base images, GitHub Actions, Supabase CLI, VROOM/VROOM Express, and npm
  dependencies pinned. Update `THIRD_PARTY.md` with every upstream change.
- Preserve `LICENSE.atomic-crm.md`, `NOTICE.md`,
  `NPM_THIRD_PARTY_NOTICES.txt`, the VROOM runtime inventory at
  `infra/vroom/runtime-package/NPM_THIRD_PARTY_NOTICES.txt`, and the exact pins
  in `THIRD_PARTY.md`.
- StoryOps AI has no root-project distribution license selected. Do not add a
  package/container license claim or distribute the project until the owner
  records that manual YELLOW decision.
- Scan the lockfile/container and review `npm audit` results; do not use a
  forced breaking update without tests.
- Review CSP/connect/image/form origins when adding a provider.
- Logs and traces must redact secrets, authorization, raw customer content,
  coordinates, signed URLs, card/bank data, and photo bytes.
- Backup/restore, retention, legal hold, and incident behavior are release
  controls, not post-launch chores.

## Pull-request/release checklist

- [ ] Requirement and controlling source are named.
- [ ] No incompatible or unlicensed source was copied.
- [ ] Domain, schema, policy, UI, docs, and tests agree.
- [ ] RBAC/RLS and cross-company/customer/assignment negatives pass.
- [ ] Pricing remains deterministic and exact.
- [ ] AI/provider failure and unknown states fail closed.
- [ ] Sensitive action approval binds the exact payload.
- [ ] Idempotency/retry/replay behavior is tested.
- [ ] No secrets, customer data, generated backup, or test artifact is staged.
- [ ] Lint, typecheck, unit/integration, build, E2E, and relevant database gates
      pass from the locked graph.
- [ ] Hosted GitHub Actions: a job with empty `steps` and no `runner_name` is
      unexecuted. Classify it with `npm run check:hosted-ci`. Do not treat that
      red X as a test pass or as a product-test failure.
- [ ] `docs/STATUS.md`, third-party pins/notices, and release evidence are
      updated.
