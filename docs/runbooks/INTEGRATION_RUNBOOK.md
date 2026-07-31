# StoryOps Integration Operations Runbook

**Purpose:** Keep external communications, payments, calendar, weather, routing, storage, and
accounting state accurate.  
**Owner:** Company owner; technical operator for secrets/webhooks  
**Last updated:** 2026-07-30

## Daily

| Task               | What to inspect                                       | Failure response                                                                                                           |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Integration health | Mode, status, latency, last error                     | Use manual/sandbox fallback; never hide disabled mode                                                                      |
| Webhook queue      | Oldest `received`/`failed`, duplicate/conflict count  | Reprocess by stable event ID; incident on payload conflict                                                                 |
| Messages           | Accepted vs delivered vs failed                       | Sandbox states are synthetic local-ledger evidence only; do not resend live work until idempotency/provider state is known |
| Outbound executors | Readiness, backlog, oldest queued, submission unknown | Restore the reviewed scheduler/manual runner; quarantine unknown submission and never substitute a hand-send               |
| Identity invites   | Disabled/pending/provider accepted/unknown vs linked  | Disable `supabase_auth`, preserve the exact command, and reconcile Auth before retry; accepted is not delivered or access  |
| Payments           | Open/paid/refunded vs signed provider and local scope | Reconcile exact provider identity, amount, currency, purpose, and current ledger state; pause collection on any conflict   |
| Calendar           | Local visits vs provider event IDs                    | Freeze auto-booking if duplicate or stale                                                                                  |
| Weather/routes     | Observation time and unknowns                         | Refresh before dispatch; owner handles alerts/unknowns                                                                     |
| Core field media   | Failed uploads/read-back/checksum/finalizer packets   | Keep completion pending; retry exact packet or investigate RLS/Edge—never broaden access/overwrite                         |
| Signed targets     | Failed optional signed-target issuance/use            | Request a new short-lived target; do not treat it as field readiness                                                       |
| Company lifecycle  | Server status, latest receipt, paused-device queue    | Stop new work while paused; reconcile accepted provider truth and preserve metadata-only recovery evidence                 |

In Supabase mode, run active health checks only as an authenticated owner or
dispatcher. The Edge boundary consumes a durable per-user hourly probe budget;
do not work around a 429 by changing identities or repeatedly restarting the
function.

Provider health covers the optional server-signed target adapter under
`SIGNED_STORAGE_TARGETS_*`; it does not certify core field media. In
authenticated Supabase mode, prove field readiness with an assigned-user
canary: immutable private upload, read-back, actual-byte checksum, trusted
finalization, exact replay, denied overwrite/direct command/direct DML, and
blocked completion on any failed dependency. Sandbox mode must show zero
Supabase Storage traffic.

## Company operational pause

Only an authenticated owner with active membership may submit the finite
lifecycle command. The client requires a factual reason and exact company-name
confirmation; the server verifies the expected and target status, canonical
request hash, actor, and idempotency identity. A profile/settings update,
provider credential, service role, dispatcher, technician, or automation cannot
pause/reactivate the company.

On a confirmed pause:

1. stop all manual initiation of new sends, bookings, checkouts/refunds,
   AI/photo runs, uploads/finalization, and other provider-backed work;
2. retain the lifecycle receipt and latest server readback, then inspect pending
   offline packet counts/metadata without opening customer payloads;
3. continue signed callback/provider retrieval for actions already accepted and
   record bounded failure state when completion is uncertain;
4. keep queued post-service work queued—paused workers cannot claim/start it—and
   do not hand-send around the gate;
5. allow trusted retention and scope-photo orphan cleanup, recording their
   bounded results; and
6. treat an already-issued short-lived upload token as sensitive until expiry.
   No fresh scope-photo signed target is minted while paused, and the paused
   company cannot finalize/register an uploaded object.

When reactivating, reconcile all accepted/unknown provider actions first. The
owner submits the exact `paused → active` request, verifies its receipt/history,
and reloads the full server workspace. Only then may original queued work resume
under its existing idempotency identity. Reactivation does not change any
provider mode/enable flag, approve launch, or make an unknown external action
safe to retry.

## Weekly

- Reconcile one full sample across lead → message → quote → booking → invoice → payment.
- Inspect Twilio/Stripe webhook signature failures. A burst is an incident signal.
- Check opt-outs were applied before later sends.
- Check retry counts and rate-limit responses.
- Verify VROOM unassigned jobs are visible; never silently discard them.
- Verify QuickBooks exports by invoice IDs and checksum.
- Test one sandbox payment, message, booking, weather unknown, route, and upload target.
- Sample normalized lead-intake receipts across web/chat/email and Twilio
  SMS/voice. Match event, resolved customer-or-lead subject, thread, message,
  and consent IDs.
- Sample Stripe/Twilio/email reconciliations. Confirm a verified event owns one
  processing lease, transitions one intended entity by stable ID, and records a
  bounded processed/ignored/failed disposition.

## Secret rotation

1. Create the replacement restricted credential in the provider console.
2. Store it in the server secret manager; never paste it into source, issue, chat, or screenshot.
3. Deploy/restart the server boundary.
4. Run the capability health check.
5. Exercise one provider test transaction with a unique idempotency key.
6. Reconcile its callback/provider ID.
7. Revoke the old credential.
8. Record rotation time, actor, provider, and result without the secret.

If step 4–6 fails, restore the old credential if still safe, disable live mode, and open an incident.

## Webhook replay

1. Find the original provider event ID in `webhook_events`.
2. Compare payload hash; a mismatch must not be processed.
3. Confirm the business entity has not already reached the intended state.
4. Move only failed/received work back through the finite
   claim/start/reconcile/complete processor.
5. Use the original event ID; never invent a replacement ID.
6. Confirm one resulting audit event and provider/entity linkage.

The endpoint returning `duplicate: true` is a successful deduplication, not a
processing failure. A same event ID with a different payload hash is an
incident. An active processing lease returns retryable `503`; after five
minutes, a new token may reclaim a crashed lease. Persistence/completion require
that exact token, so never hand-edit a claimed event or lease to make it replay.

Twilio inbound messages use `SM…:inbound_message` through the lead-intake
processor even if the signed request reaches `provider-webhook`; delivery
callbacks continue through provider reconciliation. Never replay an inbound
message through `reconcile_provider_webhook`: that legacy consent branch is
blocked. Use the stored intake receipt and original payload hash.

## Post-service outbound worker

The worker has a private network credential that is separate from the database
service role. Set `POST_SERVICE_WORKER_TOKEN` to an independent random value of
at least 32 bytes and set `POST_SERVICE_WORKER_MODE` to exactly `manual` or
`scheduled`. The endpoint rejects short or whitespace-padded tokens,
service-role reuse, reuse of the transactional worker token, a missing/invalid
activation mode, and a request trigger that does not match the configured mode.
The service-role key is read only inside the Edge runtime for narrow worker
RPCs; it is never a network bearer.

Invoke `POST /functions/v1/post-service-worker` from a reviewed private
scheduler with the dedicated token and a bounded body:

```json
{
  "companyId": "<active-company-uuid>",
  "trigger": "scheduled",
  "batchSize": 10,
  "leaseSeconds": 90
}
```

For a supervised one-shot run, temporarily configure mode `manual` and use
`"trigger":"manual"` with the same exact `companyId`. Do not use manual mode as
an unrecorded substitute for a failed scheduler. `batchSize` is hard-limited to
1–25 and `leaseSeconds` to 30–300. In scheduled mode, configure an interval
between 60–3,600 seconds; the reviewed V1 default is 900 seconds during approved
contact hours. Keep the token in the scheduler secret store, never in the
browser, URL, source, shell history, or scheduler log.

For every run:

1. inspect `claimed`, per-status counts, and safe result metadata;
2. treat `sandboxed` as local execution only—no customer delivery occurred;
3. treat live `submitted` as provider acceptance only and wait for signed
   callback or provider retrieval to reach `completed`;
4. treat `submitted_unknown` / `submission_unknown` as a manual reconciliation
   incident and never resend it;
5. investigate `cancelled` as expected fail-closed consent/contact/plan drift;
6. allow the durable exponential retry schedule only for failures known to
   occur before provider submission and for read-only receipt retrieval; and
7. alert when the oldest queued/submitted record, any `submitted_unknown`
   record, or retry count exceeds the reviewed operational threshold.

Provider retrieval failure must never be diagnosed as provider delivery
failure. When the worker has a known live provider ID and exhausts its bounded
receipt-read budget, the durable row remains `submitted`, retains the
provider/message identity and last provider status, records
`RECONCILIATION_EXHAUSTED` and the separate provider-read error, requires manual
reconciliation, and is excluded from automatic resend. A verified callback can
still resolve it. For transactional quote and on-my-way messages, one active
attempt is permitted per company and business entity across channels; do not
switch channels to bypass that serialization.

The claim/start boundary also requires an active company. While paused, it
claims no new queued follow-up and cannot begin a pre-claimed send. A previously
submitted provider action may still move through signed callback/retrieval
reconciliation; do not confuse that truth-preserving transition with permission
to start another send.

`post-service:<followup UUID>` is a durable StoryOps correlation key. It is not
a Twilio Message-create idempotency guarantee. Immediately before a live
Twilio create call, the worker commits `submitted_unknown` under the exact
lease. A returned authoritative Twilio SID advances the row to `submitted`;
an acceptance/timeout ambiguity, malformed response, worker crash, or uncertain
database completion leaves it quarantined and excluded from future queue
claims. If the SID is known, it is preserved on both the follow-up and message
for signed callback/manual provider lookup. If no SID is known, reconcile the
approved recipient, From number, narrow send window, and Twilio account logs;
never invent a SID or hand-send while uncertainty remains.

Live post-service marketing email is disabled in V1.1. Sandbox email remains
available, but live activation fails closed until a reviewed provider-specific
signed unsubscribe endpoint, durable suppression update, and bounce/complaint
path are implemented and tested. Live post-service SMS additionally requires
the configured signed Twilio callback/company mapping so STOP and delivery
events can reconcile. Recurring reminders are materialized once per plan/due
date only when current marketing consent and a usable contact both exist;
every reminder states that a fresh estimate is required before booking.

## Transactional quote/on-my-way worker

Quote delivery and on-my-way messages are durable queue requests, not provider
delivery. They leave the queue only through
`POST /functions/v1/transactional-outbound-worker`. Configure an independent
`TRANSACTIONAL_OUTBOUND_WORKER_TOKEN` of at least 32 bytes and choose exactly
one activation mode:

- `disabled`: no invocation is authorized;
- `manual`: a supervised request must declare `"trigger":"manual"`; or
- `scheduled`: the private scheduler must declare `"trigger":"scheduled"`.

The endpoint rejects the service-role key and the post-service worker token.
Use a bounded scheduled request such as:

```json
{
  "companyId": "<active-company-uuid>",
  "trigger": "scheduled",
  "batchSize": 25,
  "leaseSeconds": 90
}
```

The transactional schedule interval is constrained to 15–900 seconds; start at
60 seconds. At 25 records per run this is an explicit maximum claim rate of
1,500 records/hour before provider-level rate budgets and consent/launch gates.
Use one scheduler identity and a stable deployment configuration. Concurrent
runs remain lease-safe, but do not increase concurrency to hide a provider
outage.

After activation, an authenticated owner or dispatcher must run Integration
Health and verify:

1. executor readiness is `ready`, credential status is `valid`, and the
   reported activation mode/accepted trigger match the scheduler;
2. queue evidence is `verified`, with separate quote-delivery and on-my-way
   backlog counts;
3. `submissionUnknownCount` is zero;
4. `oldestQueuedAgeSeconds` stays below
   `OUTBOUND_WORKER_QUEUE_ALERT_AFTER_SECONDS` (default 900); and
5. a sandbox canary queues both actions, processes them as `sandboxed`, and a
   second run claims zero records.

Any submission-unknown record, unavailable queue projection, active-mode
credential defect, disabled worker with backlog, or service/peer credential
reuse blocks executor health. An aged queue degrades it. A scheduled call must
carry one exact active `companyId`. Each successful or failed invocation writes
a company-scoped heartbeat after its credential, body, configuration, and scope
are accepted. Later processing failures write a failed heartbeat on a
best-effort basis. An earlier rejection writes no heartbeat and becomes a
missing/stale block, so every non-2xx still requires an operator alert.
Service-only scheduled refresh recomputes all four queues from current database
state. Launch remains ready only while every worker has a recent successful
`scheduled` heartbeat from the same configuration and release deployment, with
no queue blocker. Manual and disabled modes are safe but never live-ready.

Set `STORYOPS_RELEASE_ID` to the immutable bare image digest, commit SHA, or
platform deployment ID used by the running Edge release. Each of the
post-service, transactional-outbound, scheduling-reconciliation, and
scope-photo-cleanup workers must have its own token and reviewed schedule. An
owner/dispatcher Integration Health probe establishes the deployment/config
generation; scheduled heartbeats then refresh its current queue and runtime
evidence without impersonating that verifier. Rotating a worker token, schedule
policy, or release ID requires a new Integration Health probe and a successful
heartbeat from all four workers before provider launch can authorize new work.
Alert independently on scheduler invocation failure and every non-2xx response.
Never resend a `submitting`, `submitted`, or `submitted_unknown` action without
authoritative provider reconciliation.

Every manual or scheduled private-worker request is exact-company scoped. The
legacy global/no-company claim signatures are dropped by migration
`20260728660000`; no scheduler or recovery script may call them. A request for
one company cannot lease, expire, cancel, reconcile, or clean another company's
record.

Migration `20260728660000` also repairs only the unambiguous legacy rows whose
known provider/message identities prove that earlier receipt-read exhaustion
was misclassified as delivery failure. Its private upgrade assertion stops the
migration when the legacy state is ambiguous, and active cross-channel
duplicates make the entity-level unique index fail rather than selecting a
customer contact to trust. Reconcile those rows from authoritative provider
evidence before retrying the upgrade.

Scheduled refresh snapshots are bounded operational telemetry, not canonical
audit evidence. StoryOps retains the 2,048 most recent scheduled refreshes and
prunes in batches only after the unprotected set exceeds 2,111. Staff probes,
the latest snapshot, and every launch-event-bound evidence version are never
pruned by this worker. The four current heartbeat rows and canonical launch/
audit events remain the source of continuous/current and historical authority.

For Stripe, reconcile company metadata, local quote/job/invoice/payment/
approval, provider object ID, USD integer amount, and current state. For
Twilio/email, reconcile exactly one outbound message by provider message ID;
apply opt-in/out only through the verified contact fingerprint and current
company records. Never use record counts or callback prose as proof.

Keep `provider_checkout_id` (`cs_*`) separate from `provider_payment_id`
(`pi_*`). A signed terminal `checkout.session.expired` or
`checkout.session.async_payment_failed` retires only that exact checkout
attempt, increments the attempt number, and permits a replacement with a new
provider idempotency suffix. A late success for a retired identity must become
a collection hold; never silently bind it to the replacement attempt.

When signed provider evidence confirms funds but current invoice version,
status, amount, or balance prevents safe allocation, inspect
`payment_allocation_conflicts` through the owner Finance projection. Collection
stays paused. If—and only if—the generated approval action is
`payment.allocation.apply_exact_current_balance`, the owner may approve the
exact payload, record a reconciliation note, and invoke
`resolve_storyops_payment_allocation`. Overpayment, underpayment, mismatched
local amount, and retired-checkout success remain non-executable in V1.1 until a
separately approved provider-backed refund or accounting resolution is
implemented and evidenced.

Before enabling live Stripe, confirm the service role can execute
`resolve_stripe_billing_identity` and `save_stripe_customer_mapping` but cannot
select customers or directly read/write provider mappings. Mapping saves must
present the opaque fingerprint returned by the immediately preceding identity
resolution. Treat stale identity or cross-customer provider-ID conflicts as
blocked reconciliation, not a reason to overwrite the local mapping.

For a signed inbound STOP, confirm all of the following before closing the
event: exactly one customer or lead subject matched; a converted lead linked to
that customer was collapsed even if its linked customer no longer held the
contact; both latest SMS
purposes are `withdrawn`; a matched customer has `do_not_contact = true`; the
webhook receipt has no `From` or `Body`; and one `lead_intake_persisted` audit
exists. No/ambiguous matches remain failed for owner investigation, but first
verify their `contact_suppressions` row is active, the non-content receipt says
`contactSuppressed=true`, and any pre-existing exact consent snapshot now
returns `OPTED_OUT`. START is not permission to resume: both purposes become `unknown` with
`sms-keyword-review-v1`, and customer suppression remains set until a reviewed
consent workflow records a new grant.

For live outbound authorization, confirm the service role has EXECUTE on
`authorize_outbound_contact` but no direct DML or SELECT on customers, leads,
or consent records. An allowed decision must cite the requested snapshot as
both the exact and latest consent evidence. A stale, withdrawn, mismatched, or
suppressed decision must stop before any provider or rate-budget call.

## Provider outage

1. Confirm health from StoryOps and the provider status page.
2. Disable the affected auto-action; keep unrelated integrations running.
3. Use manual fallback with a written list of provider actions and IDs.
4. Tell customers only what is known. Do not promise a provider recovery time.
5. After recovery, reconcile manual and queued work before turning automation back on.
6. Watch duplicates, callbacks, and rate limits for one hour.

## Live activation

Use the launch gate in `docs/architecture/INTEGRATIONS.md`. Activation is one provider at a time.
Start with provider test mode where available. Do not activate communications and payments in the
same change window.

For inbound lead traffic, require `LEAD_INTAKE_MODE=live` plus
`LEAD_INTAKE_LIVE_ENABLED=true`, and keep
`TWILIO_LEAD_INTAKE_WEBHOOK_URL` distinct from the Twilio delivery callback
URL. Stripe/Twilio/email callback ingress obeys that provider’s exact mode and
live flag. Any missing, invalid, or mismatched pair is disabled.

Identity invitation delivery separately requires
`STORYOPS_IDENTITY_INVITE_MODE=live` and
`STORYOPS_IDENTITY_INVITE_LIVE_ENABLED=true`. Run Integration health first:
its Supabase Auth probe is read-only and records no invite. Then the owner must
activate `supabase_auth:identity_invitation`, complete its exact trusted canary,
and re-authorize controlled launch. Disable either environment switch and rerun
health, use the owner provider-disable command, or pause the company to stop new
invites. Reconcile every `provider_submission_unknown` command before
reactivation; never resend from switch state alone.

The repository includes live adapters, but no real credential or external
canary has been exercised. Before each activation, record the exact credential
owner/scope, callback/OAuth URL, health result, test ID, local/provider/audit
IDs, reconciliation result, legal/accounting/safety sign-off where applicable,
and rollback. “Adapter compiled” is not a passed canary.

For Google Calendar, prefer the OAuth client/secret/refresh-token set and prove
refresh plus one 401 recovery. The short-lived access-token option is for local
diagnostics, not a durable production credential strategy. Confirm the one
allowlisted calendar before reading or writing.

For approved Stripe refunds, the owner decides the exact persisted approval and
then invokes the approved-action executor once. A replay with the same approval
returns the durable receipt; changed amount/payment/payload, stale approval,
ineligible state, or another role must fail. If the provider may have completed
but StoryOps completion is uncertain, keep the same idempotency key and
reconcile before retry.

For exact payment allocation, never use the generic approved-action executor.
The Finance resolver rechecks active owner membership, exact conflict/invoice
versions, provider identities and amounts, the current invoice balance, and the
single matching unconsumed approval in one transaction. If any value drifted,
leave the collection hold open and reconcile again.

## Backup evidence

Backups must include integration connection metadata (not secrets), webhook receipts, idempotency
records, message/payment/calendar provider IDs, approvals, AI traces, and audit events. Confirm a
restore preserves uniqueness constraints before replaying any external event.

For the pilot authorization restore check, follow the stricter
[signed isolated-restore procedure](../compliance/BACKUP-RESTORE.md#signed-isolated-restore-evidence-for-pilot-authorization).
The restore runner writes a private signed artifact but never submits it.
Before the authenticated owner manually submits its exact request/header to the
trusted verifier, inspect its company, command UUID, expiry, migration
`20260728660000`, source-manifest hash, target-dump hash, isolation reference,
and completion time. A changed field, reused signing secret, old migration,
nonempty/remote target, or failed RLS/Storage sentinel blocks the proof.

## Changelog

- **2026-07-29 — v1.1:** Added normalized intake, durable provider
  reconciliation, OAuth refresh, health-budget, approved-refund operations,
  checkout retirement, allocation quarantine, and exact current-balance
  resolution, plus company-wide paused-provider start denial and
  truth-preserving reconciliation.
- **2026-07-28 — v1.0:** Initial integration cadence, rotation, replay, outage, and activation.
