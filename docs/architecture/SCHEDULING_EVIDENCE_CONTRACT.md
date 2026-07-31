# Scheduling evidence and booking-promotion contract

**Status:** database and trusted Edge boundaries implemented; live-provider
deployment, activation, and external canaries remain gated  
**Owner:** company owner (operating policy) and principal engineer (technical
boundary)  
**Last reviewed:** 2026-07-29  
**Applies to:** Google Calendar capacity/event reconciliation, NWS weather,
VROOM routing, crew capacity, visit creation, and booking promotion

## Release verdict

Migration
`supabase/migrations/20260728160000_scheduling_evidence_boundary.sql`
implements the database enforcement boundary for scheduling evidence:

- immutable, provider-distinguishing scheduling receipts and one-time
  consumption records;
- a service-role-only evidence recorder;
- exact published-configuration and active-operating-baseline binding;
- canonical request, provider-payload, policy, and receipt hashes;
- persisted VROOM route and NWS weather rows;
- confirmed Google Calendar event read-back evidence;
- live-only consumption by the finite booking RPC;
- a transaction-local promotion authorization, advisory lock, locked capacity
  recheck, and direct-DML guards; and
- an authenticated owner/dispatcher candidate lookup that returns only the
  identity of a fresh live receipt.

This closes the former database gap in which mock or mutable route/weather rows
could support a confirmed visit. It does **not** make live automated scheduling
operationally release-ready by itself.

The repository contains the authenticated owner/dispatcher
`scheduling-evidence` Edge function that gathers the three provider results,
creates and reads back the deterministic Google event, and calls the
service-only recorder. It also contains the private-token
`scheduling-reconciliation` worker for durable ambiguous calendar attempts.
The separate authenticated `scheduling-suggestions` function is read-only at
the scheduling boundary: it uses the service-only candidate projection to rank
a bounded set of business-hour windows by current internal crew, membership,
skill, equipment, inspection, reservation, visit-conflict, and appointment
buffer facts. Every suggestion is explicitly `bookable: false`; Google
Calendar free/busy, VROOM route, and NWS weather remain `unknown` until the
operator submits that exact window to `scheduling-evidence`. Suggestions never
create provider events, receipts, visits, dispatch assignments, or customer
messages.
These paths are source-implemented and locally tested; they are not deployed,
live-enabled, connected to an autonomous production trigger, or proven against
real providers by this build. No production credentials or external-provider
canary results are included. The calendar-first boundary also requires a
reviewed compensation procedure when a Google event exists but evidence
recording or local booking fails. Until those manual and live-provider gates
are completed, keep live automatic booking disabled.

Sandbox and SQL fixtures may prove the boundary without keys, but they do not
prove a real slot, route, forecast, calendar event, or customer commitment.
The authenticated local Edge canary proves only the disabled-mode actor/RPC
boundary; it makes no provider call and is not a live scheduling canary.

## Authority and terminology

Scheduling follows `docs/SOURCE_OF_TRUTH.md`.

- **Provider observation:** a typed Google Calendar, NWS, or VROOM result. It
  remains untrusted until bounded and persisted by trusted server code.
- **Scheduling evidence receipt:** one immutable aggregate that binds an exact
  company, job/version, property, crew/version, window, configuration,
  operating baseline, calendar read-back, route check, weather check,
  uncertainty set, expiry, and hashes.
- **Booking candidate:** the bounded identity returned by
  `get_storyops_booking_candidate`. It is not a separate mutable proposal and
  does not authorize booking on its own.
- **Booking promotion:** the atomic act of consuming one eligible scheduling
  receipt to create the confirmed visit and dispatch assignment and to
  transition the job to `scheduled`.
- **Evidence consumption:** the immutable one-to-one link between a receipt and
  the visit it promoted.
- **Calendar reconciliation:** exact event ID, confirmed status, etag,
  reconciliation timestamp, and bounded payload hash proving that the
  provider event was read back before evidence was recorded.
- **Customer confirmation receipt:** independently reconciled delivery evidence
  for an outbound booking message. It is outside
  `20260728160000_scheduling_evidence_boundary.sql`; a calendar attendee or
  provider acceptance is not delivery.

Owner approval cannot turn sandbox, mock, stale, unknown, cross-company,
incomplete, or conflicting evidence into live evidence.

## Implemented database contract

### Immutable receipts and consumption

`scheduling_evidence_receipts` is append-only and stores:

- company, job/version, property, crew/version, and exact UTC start/end;
- `evidence_mode` (`live` or `sandbox`) and exact configuration revision;
- capacity provider, reference, disposition, observation/expiry, bounded
  payload, and payload hash;
- Google event ID, status, etag, reconciliation timestamp, and calendar payload
  hash;
- active operating-baseline publication ID and hash;
- route/weather row IDs, dispositions, observation/expiry, policy version, and
  request/response/payload hashes;
- bounded unknowns and conflicts;
- aggregate expiry as the earliest component expiry;
- canonical evidence and request hashes, idempotency key, trace, actor, and
  creation time.

`scheduling_evidence_consumptions` makes a receipt single-use and binds it
one-to-one to a visit. The visit also retains
`scheduling_evidence_receipt_id`. Receipt and consumption updates/deletes are
rejected by immutable triggers.

`route_checks` and `weather_checks` are now appended only inside the trusted
recorder for this flow. Their old browser write policies are removed, normal
roles lose direct write grants, and update/delete attempts are rejected by the
same immutable guard. Existing foreign-key deletion semantics are therefore
not an operating deletion path.

### Service-only evidence recorder

`record_storyops_scheduling_evidence(company, actor, idempotency, request_hash,
evidence)` is `SECURITY DEFINER`. `EXECUTE` is revoked from `public`, `anon`,
and `authenticated` and granted only to `service_role`.

The recorder:

1. requires a currently active owner/dispatcher actor for the company;
2. accepts only the finite `storyops-scheduling-evidence-input-v1` envelope and
   rejects extra fields or unbounded input;
3. computes the canonical request hash server-side and rejects a mismatch;
4. replays the original receipt for the same company/key/hash and rejects
   same-key/different-input reuse;
5. locks and validates the exact ready-to-schedule job/version, property,
   referenced estimate duration, active crew/version, service requirements,
   membership, equipment, inspection dates, and local overlap state;
6. requires the exact configuration revision to be published in the submitted
   mode and the referenced operating baseline to be active for that revision;
7. enforces the provider tuple:
   `google_calendar` + `vroom` + `nws` for live, or
   `mock` + `mock` + `mock` for sandbox;
8. validates provider freshness, window coverage, resource scope,
   dispositions, unknowns, and conflicts;
9. appends the VROOM/NWS rows and one aggregate receipt; and
10. returns only the bounded receipt representation.

The recorder records evidence; it does not confirm a visit. Although it can
record a sandbox receipt for deterministic testing, the booking boundary can
never consume that receipt.

### Exact calendar event read-back

An eligible capacity result must include all of the following:

- provider `google_calendar` in live mode;
- the exact job, crew, start, and end in the bounded capacity payload;
- `busy = false` and `readBackConfirmed = true`;
- non-empty event ID and etag;
- provider and payload event status `confirmed`;
- payload event ID and etag equal to the top-level read-back fields;
- a reconciliation timestamp no more than ten minutes old; and
- empty receipt unknown/conflict collections.

The recorder hashes the bounded calendar payload. Booking rechecks the event
status, ID, etag, reconciliation age, capacity claims, whole-receipt hash, and
aggregate expiry. `20260728160000_scheduling_evidence_boundary.sql` does not
itself call Google; the trusted Edge path must use the allowlisted calendar
adapter and must supply genuine provider read-back.

This means the implemented order is:

1. gather live availability, weather, route, and local-capacity facts;
2. create or retrieve the deterministic Google event;
3. read back that exact event;
4. record the aggregate evidence through the service-only RPC; and
5. consume the receipt in the local booking transaction.

The ordering prevents StoryOps from confirming a local visit without a
reconciled calendar event. It also creates the explicit compensation case
described below if steps 2–4 succeed but step 5 fails.

### Exact VROOM and NWS rows

For live receipts, the recorder appends:

- one `route_checks` row with provider `vroom`, the exact job/property/crew/
  window request, feasibility, drive/distance results, violations, and
  canonical request/response hashes; and
- one `weather_checks` row with provider `nws`, exact property and covering
  forecast period, forecast issue/check time, bounded weather values,
  condition codes, policy disposition, raw forecast payload hash, and separate
  weather-policy version/hash on the receipt.

An eligible VROOM result must be feasible with no violations. An eligible NWS
result must cover the full booking window. The live adapters remain responsible
for validating provider response completeness before the trusted worker
submits the bounded envelope; the database then binds and revalidates the exact
persisted rows at booking.

### Canonical hashes and policy binding

`storyops_canonical_json` and `storyops_json_sha256` provide byte-stable,
server-side canonical JSON hashing for the finite envelopes. The recorder does
not trust a caller-provided hash label:

- its complete request hash includes actor, company, evidence, and idempotency
  key;
- capacity, calendar, VROOM request/response, weather payload, and weather
  policy are hashed independently; and
- an insert trigger calculates the whole-receipt evidence hash.

Booking recomputes the finite command hash and the receipt hash and checks the
persisted VROOM/NWS hashes. It also requires the receipt’s configuration
revision to remain published/live and its exact operating-baseline publication,
configuration revision, and baseline hash to remain active and consistent.

### Live-only booking consumption

For `job.book`, `execute_storyops_golden_path_command` accepts only:

```json
{
  "entityId": "<job UUID>",
  "schedulingEvidenceReceiptId": "<receipt UUID>"
}
```

The authenticated actor must be an active owner or dispatcher. The transaction
rejects a missing, used, expired, sandbox, ineligible, changed, unknown, or
conflicting receipt. It also revalidates:

- exact company, job/property/version, quote, deterministic duration, verified
  deposit, active service catalog, and one checklist template;
- confirmed/recent Google event read-back and free capacity claim;
- exact immutable VROOM row, hashes, feasibility, and 30-minute freshness;
- exact immutable NWS row, payload hash, eligible policy disposition, full
  window coverage, 60-minute check freshness, and six-hour forecast freshness;
- exact published live configuration and active operating baseline; and
- current crew version, skills, membership, equipment, inspection status, and
  overlapping visits.

The transaction takes an advisory lock for the exact crew/window key and then a
`FOR UPDATE` lock on the crew while it rechecks all overlapping visits. It
creates the confirmed visit, confirmed dispatch assignment, checklist items,
scheduled job transition, and immutable consumption in one transaction.
Command replay uses the `golden-path-booking-v2` idempotency scope; changed
input under the same command ID is a conflict.

### Promotion guard and direct-DML closure

Confirmed visit/dispatch state and a job transition to `scheduled` require a
private authorization row bound to the current backend PID and transaction ID.
Only the finite booking RPC creates that authorization, and triggers verify
the exact receipt, company, job, crew, window, route row, and weather row at
each promotion step.

The private schema is inaccessible to normal API roles. Direct insert/update/
delete grants are revoked from `anon`, `authenticated`, and `service_role` for
jobs, visits, dispatch assignments, route checks, weather checks, receipts, and
consumptions. The former public implementation of the golden-path RPC is
renamed to a non-executable compatibility implementation with execution
revoked from API roles; only the new guarded wrapper is exposed to
authenticated users.

### Client candidate RPC

`get_storyops_booking_candidate(company, job, version)` is available only to an
authenticated owner/dispatcher. It returns the newest unconsumed, unexpired
live receipt with eligible capacity/route/weather and no unknowns/conflicts:

```json
{
  "companyId": "<company UUID>",
  "jobId": "<job UUID>",
  "jobVersion": 4,
  "schedulingEvidenceReceiptId": "<receipt UUID>",
  "expiresAt": "2026-07-29T15:30:00Z",
  "evidenceHash": "<sha256>"
}
```

`src/state/liveRepository.ts` calls this RPC when a booking command has no
receipt ID, validates the strict response, rejects a client-observed expiry,
and rebuilds the command/hash with the receipt ID. This lookup is convenience,
not authority: the booking transaction repeats every material check.

## Pre-departure dispatch-clearance contract

Booking evidence authorizes one confirmed visit creation; it is not fresh
departure evidence. Migrations
`supabase/migrations/20260728450000_dispatch_clearance.sql` and
`supabase/migrations/20260728520000_dispatch_current_origin.sql`, hardened by
`supabase/migrations/20260728610000_dispatch_current_origin_actor_privacy.sql`,
add a distinct boundary for `confirmed → en_route`:

- `dispatch_clearance_receipts` binds the exact company, visit/job/property/
  crew/window and current versions; reviewed property/geocode observation;
  published configuration revision/hash; active operating-baseline
  publication/hash; original scheduling receipt/hash; current provider
  connection identities and configuration hashes; immutable NWS/VROOM row
  identities and payload hashes; policy disposition; uncertainty collections;
  actor, request/evidence hashes, idempotency key, creation time, expiry,
  accuracy, observation time, consent version/time, reading ID/source, and
  opaque origin binding. Durable receipt, route, and audit rows never retain
  exact latitude/longitude or a reusable verifier.
- Exact latitude/longitude and random-HMAC verifier material exist only in
  private `UNLOGGED` tables. They are available only to the exact authorized
  departure flow, excluded from logical backup, deleted immediately on
  consumption, and become purge-eligible when the maximum two-minute envelope
  expires. A database crash intentionally invalidates the in-flight receipt.
- A five-second `pg_cron` worker performs expiry cleanup. Launch and provider
  actions fail closed unless a recent scheduler-owned successful run, bounded
  backlog, restricted ACLs, and worker health are all proven. Direct/manual
  worker execution cannot establish scheduler health. History for this exact
  job, command, database, and user is pruned in bounded batches beyond 24 hours;
  stale history backlog is itself launch-blocking. Backup excludes `cron.*`
  runtime rows, and restore recreates only the allowlisted job before waiting
  for an actual successful scheduled run.
- `dispatch_clearance_consumptions` is immutable and one-to-one with a receipt.
  It binds the exact command/request hash and visit-version progression. An
  exact same-command replay returns the stored response; a changed command or
  second consumption fails closed.
- `load_storyops_dispatch_clearance_candidate` is service-role only and returns
  the current server-owned candidate snapshot. The authenticated
  `dispatch-clearance` Edge function independently dual-gates the flow plus
  NWS/weather and VROOM/routing, fetches current live provider observations,
  evaluates finite weather/route contracts, and calls the service-only
  recorder. Sandbox results are non-authorizing.
- `consume_storyops_dispatch_clearance` is the only API transition into
  `en_route`. Under the launch lock it revalidates actor/assignment, visit and
  related versions, time window, current configuration/baseline/provider
  bindings, original booking receipt, receipt/hash/freshness, feasible exact
  route, eligible covering NWS result, and empty unknown/conflict collections.
  It installs transaction-local authorization, changes the visit, and records
  consumption atomically.
- The booking route origin is never reused as current truth. The field user must
  explicitly share a device reading accurate to 100 meters and observed within
  two minutes. Actor, company, exact visit version, origin, and reading-bound
  idempotency key are privately HMAC-bound. VROOM receives that coordinate, its
  durable request stores only the opaque binding, and receipt expiry is capped
  at two minutes after observation. Missing, denied, stale, inaccurate,
  changed, or legacy no-origin evidence fails closed.
- `visits_dispatch_clearance_guard` rejects direct DML and generic-command
  entry into `en_route`, even for privileged application paths that otherwise
  update visits. The PWA removes `en_route` from its offline command allowlist;
  legacy queued departures are retained as failed evidence and never replayed.

`UNLOGGED` storage and deletion prevent logical-backup/WAL persistence of this
ephemeral authority, but they are not a claim of cryptographic erasure from
local MVCC remnants or infrastructure-level host snapshots. The storage
provider’s snapshot behavior and the route provider’s handling of submitted
coordinates require documented privacy/legal review before live activation. A
dedicated non-persistent TTL store remains the preferred post-V1 design.

The Field action captures the exact selected live visit/version, rejects an
offline or server-unverified client and any pending mutation for that visit,
refreshes evidence, rechecks selection/state, then consumes the receipt. Any
timeout, provider error, expiry, unknown, weather hold, infeasible route,
changed binding/version, or replay leaves the visit confirmed. On-site packet
operations retain their separate offline recovery boundary; departure does not.

## Freshness and invalidation

The recorder and booking transaction both enforce freshness. The earliest
component expiry is the receipt expiry.

| Evidence                     | Implemented limit                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google capacity observation  | At record time, no more than 10 minutes old; expiry no more than 15 minutes after observation                                                                                                                                                                                                                        |
| Google event reconciliation  | No more than 10 minutes old when recorded and when booked                                                                                                                                                                                                                                                            |
| VROOM route                  | Observation no more than 30 minutes old; expiry no more than 30 minutes after observation; rechecked at book                                                                                                                                                                                                         |
| NWS check                    | Observation no more than 60 minutes old; expiry no more than 60 minutes after observation; rechecked at book                                                                                                                                                                                                         |
| NWS forecast                 | Issued no more than 6 hours ago and covers the entire candidate window                                                                                                                                                                                                                                               |
| Crew and local capacity      | Re-evaluated under transaction locks immediately before promotion                                                                                                                                                                                                                                                    |
| Aggregate scheduling receipt | Expires at the earliest capacity, route, or weather expiry; cannot be consumed twice                                                                                                                                                                                                                                 |
| Dispatch departure origin    | Explicit device consent; accuracy at most 100 m; no more than 2 minutes old; at most 30 seconds future skew; exact latitude/longitude deleted on successful use or made purge-eligible at expiry in private UNLOGGED storage; unhealthy cleanup blocks operations; local-page/host-snapshot residual requires review |

Job, crew, duration, resource, provider, window, configuration, baseline,
policy, or hash mismatch fails closed. Health status is not freshness evidence.
A healthy provider does not prove this specific event, route, forecast, or crew
window.

## Sandbox versus live

| Source/path                                           | What it proves                                                        | Live-booking eligibility |
| ----------------------------------------------------- | --------------------------------------------------------------------- | ------------------------ |
| Sandbox Calendar/Weather/Routing providers            | Deterministic no-network behavior                                     | Never                    |
| Seeded or SQL fixture evidence with mode `sandbox`    | Schema, hash, idempotency, and denial behavior                        | Never                    |
| SQL fixture shaped as live provider evidence          | Database validation logic only; it is not an external provider canary | Test-only                |
| Live adapter response not recorded by the service RPC | Typed provider parsing only                                           | Never by itself          |
| Fresh live receipt from the trusted worker            | Exact persisted evidence identity                                     | Candidate only           |
| Successfully consumed live receipt                    | One local confirmed visit/dispatch and scheduled job                  | Local booking receipt    |
| Reconciled customer communication                     | Delivery state for the approved confirmation                          | Separate requirement     |

Relabelling sandbox values as `nws`, `vroom`, or `google_calendar` is not a
supported operating path. The trusted worker and live canary must prove
provider origin; `20260728160000_scheduling_evidence_boundary.sql` enforces the
bounded persisted contract after that trust boundary.

## Remaining live activation work

The following work is operationally required and is not claimed by
`20260728160000_scheduling_evidence_boundary.sql` or by a passing local canary.

### Trusted scheduling Edge and reconciliation worker

The implemented `scheduling-evidence` path must be deployed and activated only
after operators verify that it:

- loads the exact company configuration and operating baseline;
- gets the current job, property, reviewed coordinates, crew/resources, and
  accepted deterministic duration;
- calls only explicitly enabled live Google Calendar, VROOM, and NWS adapters;
- creates/retrieves the deterministic Google event and reads it back by stable
  ID;
- normalizes provider output into the finite v1 evidence envelope;
- computes the exact compatible request hash and calls
  `record_storyops_scheduling_evidence` under `service_role`;
- never accepts provider mode, disposition, provider payload, company scope, or
  safety interpretation from model text or browser input; and
- records trace-safe failures without secrets or unrestricted provider bodies.

The implemented `scheduling-reconciliation` path must likewise be deployed
behind its separate private credential and attached to a reviewed scheduler
with bounded frequency. It may reconcile only durable claimed attempts by
stable provider identity. Do not grant the browser access to either
service-only recorder or use direct table DML as a worker shortcut.

### Provider setup and canaries

- Configure the one allowlisted Google operations calendar and least-privilege
  OAuth ownership, recovery, rotation, and revocation.
- Configure a monitored NWS User-Agent and reviewed DFW coordinates/weather
  policy.
- Deploy a pinned, authenticated VROOM/router service with bounded timeout and
  health monitoring.
- Verify the two-switch live flags and secret-safe health screen.
- Run synthetic staging canaries for stale/partial/unknown responses,
  unassigned routes, provider outages, OAuth refresh, duplicate event replay,
  ambiguous timeouts, and cross-company/resource mismatches.
- Run one explicitly approved, low-risk production canary and reconcile every
  stable provider/local ID before enabling automatic booking.

### Calendar-event compensation runbook

Before live activation, write and rehearse an operator procedure for:

- an ambiguous event-create response, resolved only by deterministic event-ID
  lookup;
- a confirmed event whose read-back succeeds but evidence recording fails;
- a recorded receipt whose booking fails because the job/crew/resource/version
  changed or a competing visit won the lock;
- a local transaction failure after the provider event exists;
- event cancellation failure or uncertain cancellation; and
- adoption of an existing event only after exact company/job/window/etag
  reconciliation and explicit owner authorization.

In every case, quarantine the provider event, do not notify the customer, keep
the same business intent/idempotency identity, and cancel or adopt by stable ID.
Never retry an uncertain create with a new ID. Automatic customer confirmation
must remain disabled until local visit, consumed receipt, provider event, and
current contact authorization agree.

Monitoring must alert on unconsumed live receipts, provider events without
local visits, local/provider divergence, expired candidates, duplicate/
overlapping visits, and reconciliation age.

## Failure and incident operations

- Missing, stale, malformed, mock, unknown, cross-company, conflicting, or
  hash-mismatched evidence: deny booking and do not contact the customer.
- Provider unavailable or rate-limited: leave the job unbooked and retry only
  bounded reads/evaluation under policy.
- Provider event outcome ambiguous: stop automatic retries and reconcile by the
  deterministic event ID.
- Provider event exists but local booking fails: quarantine and execute the
  reviewed compensation procedure.
- Receipt or route/weather row mutation attempt: preserve evidence, disable the
  worker, and investigate.
- Duplicate/overlapping booking, mock-to-live promotion, or customer-impacting
  provider/local divergence is at least SEV-2. Cross-company evidence or
  unauthorized booking/communication is SEV-1.

Use `docs/templates/INCIDENT_REPORT.md`. Repair by append-only
reconciliation/compensation; never edit evidence, relabel a mock row, delete
history, or invent availability.

## Verification and traceability

| Artifact                                                               | Implemented proof                                                                                                | Does not prove                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `supabase/migrations/20260728160000_scheduling_evidence_boundary.sql`  | Schema, service recorder, hashes, immutability, RBAC/DML closure, promotion guards, locks, consumption           | Live provider origin or worker activation              |
| `tests/integration/fixture-backed-booking-invoice-contract.sql`        | Deterministic evidence recording, receipt-bound booking, exact replay, and local non-overlap assertion           | External Google/NWS/VROOM behavior or concurrency load |
| `src/state/liveRepository.ts` and `tests/unit/live-repository.test.ts` | Strict candidate lookup and receipt-bound command reconstruction                                                 | A provider event or customer confirmation              |
| `src/core/integrations/liveServer.ts`                                  | Google OAuth/allowlist/free-busy and deterministic event behavior                                                | Worker persistence, production grant, or compensation  |
| `src/core/integrations/livePublic.ts`                                  | NWS/VROOM typed parsing and validation                                                                           | Production endpoint, policy canary, or receipt origin  |
| `supabase/functions/integration-health/index.ts`                       | Role-scoped, bounded, secret-safe reachability checks                                                            | Slot-specific evidence or booking eligibility          |
| `supabase/migrations/20260728450000_dispatch_clearance.sql`            | Immutable exact-bound departure receipt, one-time atomic consumption, and `en_route` guard                       | External provider origin or a general safety guarantee |
| `supabase/functions/dispatch-clearance/`                               | Typed dual-gated NWS/VROOM refresh and service-recorder boundary                                                 | Deployment, live credentials, or production canary     |
| `tests/integration/dispatch-clearance.sql`                             | ACL/direct-transition closure, reviewed-geocode binding, stale denial, atomic consume/replay/reuse, immutability | A real NWS/VROOM call                                  |
| `src/core/scheduling/dispatchClearance.ts` and Field/offline tests     | Strict client receipt parsing, exact command hashing, selection binding, and no offline departure                | Provider freshness without server consumption          |

Before calling live booking release-ready, additionally prove:

- direct authenticated/service-role DML denial and sandbox-consumption denial;
- same-key/same-hash replay and same-key/different-hash conflict;
- stale, future-dated, malformed, incomplete, unknown, conflicting, and
  cross-company evidence rejection;
- changed job/crew/resource/configuration/baseline/window/hash rejection;
- two truly concurrent requests cannot overlap one crew;
- exact Google event replay/read-back and ambiguous timeout recovery;
- VROOM target assignment/completeness and NWS full-window policy evaluation
  through the activated worker;
- calendar-first compensation for every failure boundary;
- customer confirmation cannot run without local/provider reconciliation and
  current contact authorization; and
- audit/backup retention of receipt IDs and hashes without secrets.

The migration is the enforced database contract. Provider credentials, worker
activation, canaries, compensation ownership, and production authorization
remain explicit human-controlled launch gates.
