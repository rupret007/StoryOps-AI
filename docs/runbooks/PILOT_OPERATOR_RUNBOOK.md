# WashOps bounded-pilot operator runbook

**Audience:** owner/operator, dispatcher, and assigned technician  
**Status:** operating checklist; not legal, tax, insurance, environmental, or safety advice  
**Last reviewed:** 2026-07-29  
**Pilot scope:** one company, approved DFW jurisdictions, and only individually authorized exterior-cleaning services

This runbook reflects the V1.1 source only when bound to the final local commit
and `BUILD_REPORT.md`; an uncommitted or later tree requires fresh review. A
local sandbox rehearsal is
available without provider keys. Authenticated setup creates a non-launch
company in `setup`; its ordinary workspace stays closed until the exact
reviewed operating baseline changes it to `active`.
`20260728160000_scheduling_evidence_boundary.sql` enforces immutable
scheduling evidence and live-only receipt consumption at the database booking
boundary. `20260728450000_dispatch_clearance.sql` separately guards departure
with a fresh, exact, single-use live NWS/VROOM receipt. The authenticated
`scheduling-evidence` and `dispatch-clearance` Edge functions and private
`scheduling-reconciliation` worker are implemented in source, but this build
does not deploy them, live-activate them, attach the worker to a production
scheduler, or prove external providers. Real delivery, payment, booking,
departure, weather, route, and field-media readiness still require separate
authoritative provider evidence and completed canaries. Local authenticated
canaries prove only disabled-mode actor/RPC boundaries.

## Truth labels

- **Synthetic:** local sandbox fixture; no customer/provider effect.
- **Submitted:** a provider may have accepted a request; not final delivery,
  payment, or booking truth.
- **Verified:** reconciled to an authoritative signed callback, provider
  retrieval, or trusted server record.
- **Unknown:** evidence is missing, stale, ambiguous, or outside the current
  projection. Unknown never means safe, available, paid, delivered, or allowed.

Never describe `setupComplete`, a green sandbox card, a browser redirect, a
local fixture, or a compiled adapter as a live success.

## One-time go-live packet

Before the first real lead, attach all of the following to one owner approval:

- signed [Texas / DFW launch checklist](../launch/DFW-LAUNCH-CHECKLIST.md);
- signed
  [exterior-cleaning safety/environmental checklist](../launch/EXTERIOR-CLEANING-SAFETY-CHECKLIST.md)
  for every enabled service;
- exact company configuration/price-book/SOP/terms/retention versions;
- service ZIP/jurisdiction matrix and permit evidence;
- tax, insurance, legal, environmental, chemical/SDS, vehicle/equipment, and
  backflow review evidence;
- role/RLS, backup/restore, observability, field-media, webhook, consent, and
  provider canary results, including a current signed isolated-restore artifact
  produced from exact migration `20260728660000`;
- deployed scheduling-evidence plus all four exact-company private workers
  (post-service outbound, transactional outbound, scheduling reconciliation,
  and scope-photo cleanup), one independent credential and reviewed scheduler/
  non-2xx alert for each, the immutable running `STORYOPS_RELEASE_ID`, current
  successful canaries/heartbeats for the same release and configuration, and a
  rehearsed Google calendar-event compensation procedure;
- deployed and independently dual-live-activated dispatch-clearance function,
  exact NWS/VROOM provider-connection authorization, external stale/hold/
  infeasible/replay canaries, and a rehearsed no-departure fallback;
- `npm run demo:proof` result;
- `npm run eval:ai` result and disposition of every reported gap; and
- named incident commander, technical operator, safety contact, insurer/attorney/
  tax contacts, municipal/water-provider contacts, and manual fallback.

If any artifact changes, re-evaluate the affected approval. Do not carry a
sign-off across a changed service, municipality, product, price book, terms,
provider, vehicle, crew, or SOP.

The restore artifact must come from the strict procedure in
[BACKUP-RESTORE.md](../compliance/BACKUP-RESTORE.md#signed-isolated-restore-evidence-for-pilot-authorization).
It requires a V2 source backup with at least one Storage object, the dedicated
`infra/restore-proof` stack, explicit loopback database and Storage endpoints,
and `--restore-storage`; `--local` is not authorization-grade isolation. The
producer rejects the source database/Storage endpoints and database system
identity, then signs both database identities, both Storage hosts, and the
read-back-verified Storage count, bytes, and canonical fingerprint.
It is not a green badge: the owner must inspect the exact company, two command
UUIDs, server completion/expiry, source-manifest and target-dump hashes, and
isolation/reference values before manually submitting its request and signature
header to the deployed trusted verifier. The restore runner never submits it or
authorizes launch. Never accept a dry run, remote/nonempty restore, old
migration, changed JSON field, failed RLS/Storage sentinel, or unsigned operator
note as equivalent evidence.

## Dispatch-origin retention scheduler

`pg_cron` is a launch-critical dependency, not an optional maintenance task.
Applying migration `20260728610000` must register exactly one job named
`storyops-dispatch-origin-purge` on a five-second cadence with command
`select private.run_storyops_dispatch_origin_purge_worker();`. The database
user and database must match the current deployment.

- Before activation and after database maintenance, run `SHOW cron.log_run;`
  through the approved database-operator channel and require `on`. Health
  depends on `cron.job_run_details`; disabled run logging is a launch blocker.
- At start of day, verify the **Integrations** retention-health card is healthy.
  Health requires a recent successful `cron.job_run_details` record for the
  exact job, command, database, and user; a manual function call cannot make it
  healthy.
- Inspect failures through the private worker-health projection and the exact
  job’s `cron.job_run_details` rows. Never copy coordinate or verifier table
  contents into logs or incident tickets.
- The worker deletes consumed/expired coordinate envelopes and prunes only its
  own successful/failed cron history older than 24 hours, in bounded batches of
  at most 5,000. A cleanup or history backlog is visible and blocks launch.
- After restore, the runner resets transient state, removes duplicate jobs,
  registers the exact job, commits that schedule, and waits for a real
  scheduler-owned success before signed evidence can be produced.
- If health is blocked, stop provider launch and departure actions. Repair
  `pg_cron`/database scheduling and re-register the exact job through a reviewed
  corrective migration or operator-approved database change that unschedules
  only the exact existing job IDs before executing the exact schedule call.
  Migration `20260728610000` is not idempotent and must not be rerun. The restore
  re-registration path applies only to the isolated recovery target. Wait for a
  real scheduled success and rerun the dispatch canary. There is no manual
  health override.

Exact origins and verifier material live in private `UNLOGGED` tables. A crash
therefore invalidates the in-flight receipt and requires a fresh user-consented
reading. Consumption deletes the row immediately; otherwise it becomes
purge-eligible at two minutes. Logical backup/WAL exclusion is not
cryptographic erasure from local MVCC remnants or infrastructure host
snapshots, and VROOM handling of a submitted coordinate remains subject to
provider/privacy/legal review.

## Start of day

1. Open **Command Center**. Read the sourced fact and source label for every
   P0/P1 item. The projection intentionally lists route, weather, and provider
   state as unknown until current evidence exists.
2. As an owner, open **Company control** and verify the server-reported company
   lifecycle state and latest history. `setup` or `paused` is not permission to
   operate; do not rely on a cached workspace.
3. Open **Approvals**. Reject expired or stale items. For a decision, open the
   source record and compare the exact recipient, property, amount, date/time,
   scope, provider target, approval payload, and hash.
4. Open **Integrations**. Record modes, last checks, errors, and required
   providers for today. Optional signed-storage-target health does not certify
   core field media.
5. Review **Pipeline**, **Dispatch**, **Finance**, and failed automation/
   webhook/offline queues. Reconcile any ambiguous provider request before a
   retry.
6. For every real visit, inspect the consumed scheduling receipt and its exact
   Google event ID/etag, VROOM row, NWS row, hashes, and freshness. Then complete
   the approved pre-dispatch weather/alert and route recheck; a prior booking
   receipt is not current dispatch clearance.
7. Inspect assigned crew, vehicle/trailer, equipment, product/SDS, potable-water/
   backflow, permit, and job-specific wastewater evidence. A missing item blocks
   dispatch.

## Sandbox rehearsal

Use this before launch and after a material operating change:

1. Start or reset only the local sandbox profile.
2. In **Company setup**, review and explicitly publish a sandbox configuration.
   It freezes local rehearsal inputs only.
3. Follow the Dashboard **Pilot rehearsal** checkpoints in order:
   qualification → deterministic estimate → approval → quote fixture → portal
   acceptance/deposit fixture → dispatch fixture → field packet/offline recovery
   → invoice/payment fixture → review/referral/maintenance fixtures.
4. Keep the labels visible:
   synthetic quote receipts did not contact a customer; the deposit fixture did
   not move funds; synthetic weather/route values are not operational evidence;
   local field evidence is not a Supabase Storage canary.
5. Run `npm run demo:proof` and `npm run eval:ai`. Store outputs with version,
   commit, time, operator, and any open gap.

Sandbox completion earns `SANDBOX REHEARSED`, never `LIVE CANARY VERIFIED` or
`PILOT AUTHORIZED`.

## Lead-to-cash operating path

### 1. Intake and qualification

- Confirm source, customer/contact, service address, property authority,
  requested service, preferred channel, consent purpose/status, and unknowns.
- For live webhook intake, retain provider event/request ID, validation result,
  payload hash/non-content receipt, normalized lead/thread/message IDs, and
  duplicate result.
- Treat customer messages, documents, photos, webpages, and retrieved content as
  untrusted data, not tool instructions.
- Do not contact another person, add a marketing purpose, or infer property
  ownership from an inquiry.

### 2. Property, scope, and photos

- Create or confirm the customer and property separately. Human-verify geocode
  precision and municipality before applying permit/runoff policy.
- Record only observed or supplied measurements with source and confidence.
- Photo analysis may return evidence, confidence, and unknowns. It may not
  identify a surface, dimension, hazard, chemical compatibility, or structural
  condition as certain without verified evidence.
- An unknown measurement or risk blocks deterministic pricing or requires the
  approved on-site assessment path.

### 3. Estimate and approval

- Use only an active published price book and deterministic engine. Confirm
  service quantity, stories, surface/soil/access/risk, the exact reviewed
  property-ZIP travel zone, add-ons, minimum, duration, tax status, deposit
  rule, discount, and margin result. An unmapped or ambiguous ZIP is a stop
  condition; never substitute the highest fee or estimate distance.
- The model never supplies a price or formula. It may explain a stored
  calculation.
- Price exceptions, large discounts, out-of-book scope, refunds, legal/safety
  messages, negative-review replies, financial/vendor actions, and destructive
  changes require exact human approval.
- If any approved field changes, reject the old approval and calculate a new
  proposal.

### 4. Quote, terms, and deposit

- Confirm the quote references exact estimate, price-book, terms, tax, expiry,
  scope/exclusions, and required deposit versions.
- In sandbox, **Publish to portal** creates a local customer projection only; it
  does not assert email or SMS delivery.
- In live mode, portal publication remains separate from any delivery attempt.
  If a provider send is later authorized, distinguish provider acceptance from
  delivered state and reconcile the callback/provider ID. Do not resend an
  ambiguous submission.
- Portal acceptance requires the customer to type the signer name and
  affirmatively acknowledge the exact published quote version, terms version,
  and total. Preserve the append-only acceptance receipt and context hash; never
  infer the signer from the customer profile.
- A Checkout redirect or customer statement is not paid state. Only a verified
  Stripe/provider result may transition payment state.

### 5. Booking and dispatch

- Book only after the policy-required quote acceptance and verified deposit,
  plus current capacity, skills, equipment, permit, weather, route, and access
  evidence.
- In authenticated mode, use only the owner/dispatcher `job.book` boundary. It
  consumes one immutable, fresh, unconsumed live scheduling receipt. Never
  create or promote jobs/visits/dispatch rows by direct DML, and never call the
  service-only evidence recorder from a browser or generic AI tool.
- The current database contract requires the allowlisted Google event to be
  confirmed and read back by exact event ID/etag before eligible evidence can
  be recorded. The booking transaction revalidates and consumes that receipt;
  the client candidate lookup does not bypass those checks.
- A sandbox/mock receipt is never booking evidence. A green integration-health
  result is reachability only, not proof of this slot.
- If the Google event exists but evidence recording or local booking fails,
  quarantine it and do not notify the customer. Reconcile by deterministic
  event ID, then cancel or adopt only through the reviewed compensation
  procedure and owner authorization. Use the
  [provider reconciliation template](../templates/PROVIDER_RECONCILIATION.md).
- Keep VROOM unassigned work visible. Do not silently turn an unassigned result
  into a booking.
- Refresh weather and route within the approved freshness window before
  dispatch. Missing/stale/conflicting evidence is unknown and blocks automated
  dispatch.
- In authenticated mode, **Check & start route** is the only supported
  `confirmed → en_route` path. It calls `visit.dispatch_clearance.refresh`,
  obtains a short-lived live NWS/VROOM receipt bound to the exact company,
  visit/job/property/crew/window, current versions, configuration, operating
  baseline, original booking receipt, and provider payload hashes, then consumes
  that receipt atomically with the visit transition.
- A prior booking receipt, integration-health result, sandbox fixture, owner
  assertion, or manually edited route/weather row is not departure clearance.
  A receipt is single-use; replay with a different command, expiry, changed
  visit/resource/configuration/baseline/provider binding, an unassigned route,
  an NWS hold, or any unknown blocks departure.
- Do not use the generic visit-transition command for `en_route`, and do not
  queue departure offline. If the device is offline, its server state is
  unverified, or refresh/consumption fails, remain `confirmed`, do not leave,
  reconnect/reload, and refresh exact evidence again. On-site field work may
  continue through its separately supported offline packet only after a
  legitimately cleared departure.

### 6. Field execution and offline recovery

- The technician uses only the assigned role-scoped packet. Confirm job,
  property, scope, exclusions, customer authorization, and dispatch/weather/
  route check before leaving.
- At arrival, complete the fresh site hazard assessment and exclusion zone
  before starting the timer/work.
- Record checklist/time, actual materials, notes, before/after photos, incidents,
  and signature. Do not backfill observations from the estimate.
- Offline-supported commands keep their original UUID, request hash, and
  expected version. Reconnect and allow the exact queue to reconcile; do not
  create duplicate commands to make a spinner disappear.
- A company pause preserves pending command/media packets but blocks their
  server replay. Recovery diagnostics may display only packet kind, status, and
  creation time—not payloads, customer/entity IDs, photo bytes, or signatures.
  After owner reactivation, require a full workspace reload before reconciling
  the original queue.
- In authenticated mode, completion waits for required private media upload,
  byte read-back/checksum, trusted finalization, checklist, materials,
  signature, and incident dependencies. A failed dependency keeps completion
  pending.
- For injury, exposure, spill/runoff, backflow, fall, heat/weather, equipment
  defect, property damage, or near miss: stop and use the
  [field incident playbook](../incidents/FIELD_SAFETY_ENVIRONMENTAL_INCIDENT_PLAYBOOK.md).

### 7. Invoice and payment

- Issue an invoice only from the completion-backed job packet and exact accepted
  commercial terms.
- Reconcile amount, tax, deposit/credit, invoice, payment, and provider IDs.
- Keep Stripe Checkout Session (`cs_*`) and PaymentIntent (`pi_*`) identities
  separate. A terminal expired/failed checkout must retire that exact attempt
  before replacement; a late success becomes a collection hold.
- Verified funds that do not fit current ledger state remain unapplied and
  pause collection. Only an exact owner-approved current-balance conflict may
  use the Finance allocation resolver. Over/under-payments, local amount
  mismatches, and retired-checkout successes require separately approved
  provider/accounting work.
- Do not mark paid from an email, screenshot, portal return, or customer claim.
- A refund requires the owner-approved exact payment, amount, reason, payload,
  and idempotency key. On ambiguity, reconcile; never create a second corrective
  action blindly.

### 8. Review, referral, and maintenance

- Confirm provider-verified paid/completed eligibility and current consent before
  outreach.
- Ask for an honest review neutrally. Do not select recipients by expected
  sentiment or reward positive sentiment. Negative-review replies require owner
  approval.
- Preserve referral terms and consent. A recurring reminder requires a fresh
  estimate before booking.
- Live post-service marketing email is disabled in V1.1. Do not use a manual send
  to bypass the missing signed unsubscribe/bounce/complaint boundary.

## End of day

1. Reconcile all submitted/unknown messages, bookings, invoices, payments,
   refunds, and field uploads against stable provider/entity IDs. For booking,
   match the scheduling receipt, one-time consumption, local visit, Google event
   ID/etag, VROOM row, and NWS row; quarantine any orphan or mismatch.
2. Resolve or explicitly carry every waiting approval, failed automation,
   incomplete field packet, incident, opt-out, and customer commitment.
3. Review tomorrow’s jurisdiction, permit, equipment, crew, product/SDS,
   weather, route, water/backflow, and wastewater needs.
4. Export/retain required audit evidence without secrets or unnecessary
   sensitive data.
5. Confirm backup/monitoring status and name the on-call human. An automated
   success badge does not replace restore evidence.

## Stop and escalate

Stop the affected capability and preserve evidence when:

- safety, environment, legality, tax, insurance, consent, or customer authority
  is unknown;
- an AI invents a fact, instruction, or source;
- provider/local state conflicts or an external result is ambiguous;
- a webhook signature, event hash, company mapping, RLS boundary, or approval
  payload fails;
- duplicate money/message/booking activity may have occurred;
- a field dependency cannot sync or validate; or
- the actual site, product, crew, equipment, weather, runoff, or scope differs
  from the approved packet.

AI may correlate supplied IDs and draft an internal timeline. It may not contact
customers, emergency services, providers, insurers, attorneys, banks, vendors,
water systems, or regulators; make a safety/legal/reportability decision;
release money; delete evidence; or declare recovery.

### Company-wide pause and recovery

When the impact is broader than one visit or adapter, a signed-in owner with
active membership may engage **Company control**. Record a 10–1,000 character
reason, type the displayed company-name confirmation exactly, and retain the
server receipt/audit event.
Queued device packets do not block the pause and must not be deleted.

Treat a confirmed pause as a server-enforced stop on new operational writes,
provider/automation starts, field evidence finalization, Storage writes, and
fresh scope-photo signed upload targets. It is not a deletion or provider
rollback. Continue read-only reconciliation for work a provider already
accepted, preserve failure truth, and allow only trusted retention/orphan
cleanup. An upload token minted before the pause remains sensitive until expiry,
but the resulting object cannot be finalized while paused; clean expired
unregistered reservations through the trusted orphan process.

Reactivate only after the cause and external state are reconciled. The owner
must submit the exact `paused → active` command, reconcile its lifecycle
readback, reload the full server workspace, and then replay original offline
packets idempotently. Reactivation never authorizes launch, enables a provider,
or approves customer contact.

## Pilot authorization record

| Decision                                                          | Owner initials/date | Evidence |
| ----------------------------------------------------------------- | ------------------- | -------- |
| Exact company/service area/services authorized                    |                     |          |
| Launch and service safety checklists signed                       |                     |          |
| Price book, terms, SOPs, products/SDS approved                    |                     |          |
| Tax, legal, insurance, environmental, AI/privacy reviews complete |                     |          |
| Role/RLS, field-media, backup/restore canaries pass               |                     |          |
| Each enabled provider canary passes                               |                     |          |
| Sandbox proof and AI eval pass/gaps disposed                      |                     |          |
| Manual fallback and incident contacts rehearsed                   |                     |          |
| Bounded pilot start/end and stop conditions approved              |                     |          |

Any blank row means `NOT READY`.

## Official operating references

Source links reviewed **July 29, 2026**; applicability and current job-specific
requirements remain subject to the named professional and authority reviews:

- [Texas Comptroller — Cleaning and Janitorial Services](https://comptroller.texas.gov/taxes/publications/94-111.php)
- [TCEQ — Cross-Connection Control and Backflow Prevention](https://www.tceq.texas.gov/drinkingwater/cross-connection)
- [TCEQ — Spills, Discharges, and Releases](https://www.tceq.texas.gov/response/spills)
- [City of Fort Worth — Mobile Commercial Cosmetic Cleaning](https://www.fortworthtexas.gov/departments/environmental-services/environmental-quality/stormwater-quality/powerwash)
- [City of Dallas — Pavement Washing Tips](https://dallascityhall.com/departments/waterutilities/stormwater-operations/PublishingImages/Keep%20Stormwater%20Clean%20Feb%2023_2021.pdf)
- [OSHA — Heat Exposure](https://www.osha.gov/heat-exposure)
- [NWS — Lightning Safety](https://www.weather.gov/safety/lightning-safety)
