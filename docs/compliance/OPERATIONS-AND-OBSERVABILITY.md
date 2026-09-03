# Environment, operations, and observability

## No-key setup

Required runtime: Node `>=22.22.3 <23` (the repository pins `.nvmrc`).

```bash
npm run setup:app
npm run dev
```

`setup:app` creates an owner-only `.env.local` from `.env.example` without
overwriting an existing file, installs dependencies when absent, verifies the
Node/runtime layout, and validates all provider modes. Every provider stays in
`sandbox`; no key is required. Read-only validation is:

```bash
npm run setup:app -- --check --skip-install
```

Use `--storyops-env-file PATH` when setup must create or read a different
owner-only environment file. Do not pass Node's reserved `--env-file` option to
`setup.mjs`; current Node consumes it before the script can create the target.

Optional local services:

```bash
npm run setup:app -- --with-supabase
npm run setup:app -- --with-routing
```

Those commands require a running Docker daemon. Every script-level Supabase
call uses exact `supabase@2.110.0` through `npx` and ignores a global CLI.
Setup inspects the project containers after start and permits only loopback
Docker host bindings (`127.0.0.1` or `::1`). A wildcard or other interface
binding fails setup; if this invocation started the stack, setup stops it
without a backup. Reconfigure the binding before retrying. Only use
`--unsafe-allow-wildcard-supabase-ports` after explicitly accepting that the
local Supabase services may be reachable from another machine.

`--with-supabase --verify` runs the repository verification and the live local
Supabase release contract against the current database. It does not reset data.
Add `--reset-supabase` only when intentionally rebuilding the local database
from migrations and the synthetic seed:

```bash
npm run setup:app -- --with-supabase --verify
npm run setup:app -- --with-supabase --verify --reset-supabase
```

Routing builds VROOM core `v1.15.0` and vroom-express `v0.12.0` from exact
commits. The VROOM build intentionally excludes GLPK and disables plan mode;
see [provider boundaries](./PROVIDER-BOUNDARIES.md#vroom-routing-service).

Default `VITE_STORYOPS_DATA_MODE=sandbox` uses only synthetic IndexedDB state.
For local Auth/RLS/RPC verification, set the mode to `supabase` and configure
the local public Supabase URL, public anon key, and seeded company UUID. The
browser then uses magic-link Auth and a role-scoped workspace RPC. Ordinary
finite workspace writes use the idempotent command RPC; first-company setup,
field-media finalization, estimating, golden-path transitions, post-service
work, and provider reconciliation cross dedicated narrower boundaries.
Service-role credentials remain server-only.

The production-like sandbox container needs no credentials:

```bash
docker compose --env-file .env.local up --build app
curl --fail http://127.0.0.1:8080/healthz
```

Always pass the reviewed environment file explicitly. Compose has no implicit
data-mode fallback. A `supabase` image build fails unless the public Supabase
URL, anon key, and company UUID are complete. Record the reviewed source in
`STORYOPS_BUILD_REVISION`; `/healthz` returns that non-secret revision and the
compiled `dataMode`. The runtime refuses startup if Compose's expected data
mode differs from the immutable build metadata.

The runtime uses a non-root user, read-only filesystem, dropped Linux
capabilities, `no-new-privileges`, loopback-only host publishing, health check,
SPA fallback, cache policy, and security headers. Terminate TLS at the approved
edge/reverse proxy. Revalidate the Content Security Policy whenever a browser
provider/origin changes.

## Environment promotion

| Environment | Data                           | Provider mode                        | Purpose                                             | Promotion gate                                                        |
| ----------- | ------------------------------ | ------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------- |
| Local       | Demo/local only                | Sandbox                              | Development, deterministic proofs, offline recovery | Setup check + unit/integration                                        |
| Test/CI     | Ephemeral synthetic            | Sandbox                              | Lint/typecheck/test/build/Playwright                | Full `demo:proof` report                                              |
| Staging     | Synthetic or approved scrubbed | Provider sandboxes/test accounts     | Webhook/OAuth/health/reconciliation                 | Security + owner acceptance                                           |
| Production  | Customer                       | Individually approved live providers | Operations                                          | DFW launch sign-off, restore drill, incident on-call, provider health |

Do not clone production customer data into local/test. If a staging case needs
production shape, generate synthetic records or use an approved, irreversible
deidentification process.

Production promotion also requires an approved retention schedule, offline
device/data policy, real provider canaries, and a selected StoryOps AI
root-project distribution license. None was supplied or exercised for this
release.

Public `VITE_` settings are build-time inputs and are inspectable by every user.
Server secrets are runtime values. Build an immutable artifact from a reviewed
commit/lockfile, record its digest, scan it, then supply live server secrets only
to server functions/workloads. Never bake a service-role/API key into the static
image.

### Live-provider change procedure

1. Keep the provider in `sandbox`; create separate sandbox/live provider
   accounts/apps and restricted credentials.
2. Validate callback URL, signature, replay/deduplication, idempotency,
   timeout/retry, rate limit, consent/approval, and reconciliation in staging.
3. Complete provider-specific evidence in
   [PROVIDER-BOUNDARIES.md](./PROVIDER-BOUNDARIES.md).
4. Add secrets in the production secret manager and rotate any value ever used
   in a developer shell, ticket, screenshot, or test log.
5. Set that provider’s mode to `live` and its explicit enable flag to `true`;
   either switch alone is disabled. QuickBooks CSV follows the same two-switch
   rule. Verify health without performing a customer action.
6. Execute one approved low-risk canary, verify provider receipt and audit
   trace, then expand.
7. Roll back by disabling that provider/returning to sandbox, not by deleting
   customer state. Reconcile any indeterminate request before retry.

## Health and readiness

There are three separate signals:

- **Liveness:** the process can answer (`/healthz`, VROOM `/health`).
- **Readiness:** migrations/config/secrets and mandatory internal dependencies
  are usable.
- **Provider health:** each optional integration’s configured mode and a
  bounded, non-mutating check.

Company operational status is a fourth, business-scoped signal. A process and
its providers may be technically healthy while the company is intentionally
`paused`; report that as an operational stop, never as application/provider
failure or permission to bypass the pause. A `setup` company likewise remains
closed until baseline activation.

The Supabase `integration-health` Edge function requires an active owner or
dispatcher membership and consumes a durable per-user hourly operation budget
before active probes. A static sandbox health card, complete environment
variables, or a compiled adapter is not an external canary.

Do not make overall application readiness fail because an optional disabled/
not-configured provider is absent. Do fail or block only the feature that needs
an unhealthy provider. Never report `healthy` for an unconfigured integration.

Machine-readable checks:

```bash
docker compose --env-file .env.local config --quiet
node infra/observability/health-check.mjs
node infra/observability/health-check.mjs \
  --vroom-url http://127.0.0.1:3000/health \
  --require-vroom
```

The probe emits newline-delimited JSON and exits nonzero when a required check
fails. Run it from outside the workload/network boundary as well as from the
orchestrator; an internal-only check does not prove customer reachability.

## Structured telemetry contract

Every log/event uses UTC ISO-8601 and these common fields:

| Field                                                              | Requirement                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `timestamp`, `level`, `event`, `service`, `environment`, `version` | Always                                                       |
| `requestId`, `traceId`, `automationRunId`                          | When a request/agent run exists                              |
| `companyId`, `actorType`, `actorId`, `role`                        | Hash/tokenize for telemetry; full value stays in audit store |
| `resourceType`, `resourceId`, `action`, `outcome`                  | State-changing or policy events                              |
| `provider`, `providerMode`, `providerId`, `idempotencyKeyHash`     | Provider operations                                          |
| `policyVersion`, `priceBookVersion`, `promptVersion`, `approvalId` | Applicable decision provenance                               |
| `durationMs`, `attempt`, `httpStatus`, `errorClass`, `retryable`   | Operational result                                           |

Never log access/refresh tokens, cookies, authorization headers, keys, webhook
secrets/signatures, database URLs/passwords, raw provider/webhook bodies,
customer message bodies, prompts/model output, signed URLs, photo bytes, card/
bank data, SDS proprietary content, or exact latitude/longitude. Error messages
must pass the same redaction path.

Audit events are domain evidence, not general logs. They are append-only and
include the exact actor/resource/action/before-after references/policy/
approval/outcome. Observability data may link the audit ID; it must not duplicate
all sensitive evidence.

## Initial service objectives

These are V1 product targets, not contractual promises:

| Signal                                      | Initial target                                    | Alert                                       |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| Web availability                            | 99.5% per rolling 30 days                         | 5-minute failure burn plus 30-minute burn   |
| Interactive API p95                         | <1.5 s excluding acknowledged async provider work | >2.5 s for 15 minutes                       |
| Webhook valid-event durable acknowledgement | 99% <2 s                                          | failure/timeout rate >2% for 5 minutes      |
| Automation low-risk completion              | 95% <60 s                                         | queue oldest age >5 minutes                 |
| Approval notification                       | 99% <2 minutes                                    | oldest unnotified approval >5 minutes       |
| Provider indeterminate actions              | 0 unresolved >15 minutes                          | any >15 minutes                             |
| Offline queued write recovery               | 100% idempotent recovery in test scenario         | any dropped/conflicting mutation            |
| Company pause propagation                   | New work denied; accepted truth still reconciles  | any post-pause start or lost reconciliation |
| Logical backup RPO                          | 24 hours                                          | latest verified backup >26 hours            |
| Restore RTO target                          | 4 hours                                           | quarterly drill exceeds target              |

Measure sandbox separately from live. Never improve a success rate by treating
`not_configured`, queued, unknown, or pending approval as success.

## Minimum dashboards

### Owner operations

- leads by source/stage and age;
- quotes sent/accepted/expired and approval wait;
- booked capacity, route/weather exceptions, unassigned work;
- jobs completed/rework/incidents/checklist exceptions;
- invoice aging, verified collected amount, deposits/refunds pending approval;
- estimated versus actual duration/material/cost/margin;
- review requests/results and recurring opportunities.

### Technical/provider

- request rate, latency, errors, offline queue/recovery;
- company lifecycle status, latest receipt/readback age, pause/reactivation
  conflicts, and privacy-safe pending-packet counts;
- automation runs by agent/disposition/retry and prompt/policy version;
- tool calls denied/approval-required/prompt-injection flagged;
- webhook signature failures, replay rejects, duplicate no-ops, processing age;
- provider accepted/delivered/failed/unknown and reconciliation age;
- database/Storage errors, RLS denials, signed-URL failures;
- backup age/checksum/Storage-object count and restore-drill age;
- app/VROOM health, container restarts, resource saturation.

## Alert routing and severity

| Severity | Examples                                                                                                                                     | Response                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| SEV-1    | Suspected cross-customer access, secret/payment exposure, public private-photo bucket, destructive unauthorized action, lost safety incident | Page owner immediately; contain; incident runbook; counsel/security/insurer |
| SEV-2    | Booking/payment/provider state corruption, all sends down, restore failure, offline data loss, repeated invalid policy execution             | Owner within 15 minutes; disable affected automation/provider               |
| SEV-3    | Single provider degradation, growing queue, expiring permit/credential, SLO burn                                                             | Same business day; feature remains visibly degraded                         |
| SEV-4    | Non-urgent defect/capacity trend                                                                                                             | Backlog with owner and evidence                                             |

Do not put customer PII in alert titles/channels. Link an access-controlled
incident/trace ID.

## Verification commands

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
npm run demo:proof
docker compose --env-file .env.local config --quiet
```

`check:edge` uses pinned Deno `2.5.6`, the frozen Edge lockfile, and every
committed Edge entrypoint. It requires Docker and is also part of CI. A passing
typecheck proves the bundle contract, not a deployed function or provider
callback.

`demo:proof` writes a new owner-only JSON artifact and fails truthfully on any
executed check. `--quick` is explicitly partial and records Playwright as
skipped. `--with-vroom` proves the running no-key custom-matrix service; it never
substitutes a public routing endpoint.

## Operational cadence

| Cadence   | Required review                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per shift | Company lifecycle/readback, integration health, approvals, failed/unknown provider actions, offline queue, schedule/weather, permit/equipment expiry |
| Daily     | Backup verified, delivery/bounce/suppression, invoice/payment reconciliation, automation failures, security alerts                                   |
| Weekly    | Restore sample metadata/checksums, least-privilege exceptions, price/margin exceptions, incidents/near misses                                        |
| Monthly   | Full disposable restore drill rotation, access review, secret age, dependency/security updates, SLO/cost review                                      |
| Quarterly | DFW legal/safety source revalidation, full restore drill, disaster/incident exercise, provider scopes/webhooks                                       |
| Annually  | Counsel/CPA/insurance/safety sign-off, retention policy, contracts/notices, business-continuity objectives                                           |
