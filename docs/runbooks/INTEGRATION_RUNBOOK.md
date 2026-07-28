# StoryOps Integration Operations Runbook

**Purpose:** Keep external communications, payments, calendar, weather, routing, storage, and
accounting state accurate.  
**Owner:** Company owner; technical operator for secrets/webhooks  
**Last updated:** 2026-07-28

## Daily

| Task               | What to inspect                                      | Failure response                                                                                                           |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Integration health | Mode, status, latency, last error                    | Use manual/sandbox fallback; never hide disabled mode                                                                      |
| Webhook queue      | Oldest `received`/`failed`, duplicate/conflict count | Reprocess by stable event ID; incident on payload conflict                                                                 |
| Messages           | Accepted vs delivered vs failed                      | Sandbox states are synthetic local-ledger evidence only; do not resend live work until idempotency/provider state is known |
| Payments           | Open/paid/refunded vs provider                       | Provider webhook/state wins; owner resolves discrepancy                                                                    |
| Calendar           | Local visits vs provider event IDs                   | Freeze auto-booking if duplicate or stale                                                                                  |
| Weather/routes     | Observation time and unknowns                        | Refresh before dispatch; owner handles alerts/unknowns                                                                     |
| Core field media   | Failed uploads/read-back/checksum/finalizer packets  | Keep completion pending; retry exact packet or investigate RLS/Edge—never broaden access/overwrite                         |
| Signed targets     | Failed optional signed-target issuance/use           | Request a new short-lived target; do not treat it as field readiness                                                       |

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

## Weekly

- Reconcile one full sample across lead → message → quote → booking → invoice → payment.
- Inspect Twilio/Stripe webhook signature failures. A burst is an incident signal.
- Check opt-outs were applied before later sends.
- Check retry counts and rate-limit responses.
- Verify VROOM unassigned jobs are visible; never silently discard them.
- Verify QuickBooks exports by invoice IDs and checksum.
- Test one sandbox payment, message, booking, weather unknown, route, and upload target.
- Sample normalized lead-intake receipts across web/chat/email and Twilio
  SMS/voice. Match event, lead, thread, message, and consent IDs.
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
incident. Do not hand-edit a claimed event to make it replay.

## Post-service outbound worker

Invoke `POST /functions/v1/post-service-worker` from a private scheduler with
the Supabase service-role bearer credential and a bounded body such as
`{"batchSize":10,"leaseSeconds":90}`. Never expose that credential to the
browser. Run at least every 15 minutes during the company’s approved contact
hours.

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

Live post-service marketing email is disabled in V1. Sandbox email remains
available, but live activation fails closed until a reviewed provider-specific
signed unsubscribe endpoint, durable suppression update, and bounce/complaint
path are implemented and tested. Live post-service SMS additionally requires
the configured signed Twilio callback/company mapping so STOP and delivery
events can reconcile. Recurring reminders are materialized once per plan/due
date only when current marketing consent and a usable contact both exist;
every reminder states that a fresh estimate is required before booking.

For Stripe, reconcile company metadata, local quote/job/invoice/payment/
approval, provider object ID, USD integer amount, and current state. For
Twilio/email, reconcile exactly one outbound message by provider message ID;
apply opt-in/out only through the verified contact fingerprint and current
company records. Never use record counts or callback prose as proof.

Before enabling live Stripe, confirm the service role can execute
`resolve_stripe_billing_identity` and `save_stripe_customer_mapping` but cannot
select customers or directly read/write provider mappings. Mapping saves must
present the opaque fingerprint returned by the immediately preceding identity
resolution. Treat stale identity or cross-customer provider-ID conflicts as
blocked reconciliation, not a reason to overwrite the local mapping.

For a signed inbound STOP, confirm all of the following before closing the
event: exactly one customer or lead matched; both latest SMS purposes are
`withdrawn`; a matched customer has `do_not_contact = true`; the webhook
receipt contains a 64-character fingerprint but no `From` or `Body`; and one
provider reconciliation audit exists. No/ambiguous matches remain failed for
owner investigation. START is not permission to resume: both purposes become
`unknown` with `sms-keyword-review-v1`, and customer suppression remains set
until a reviewed consent workflow records a new grant.

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

## Backup evidence

Backups must include integration connection metadata (not secrets), webhook receipts, idempotency
records, message/payment/calendar provider IDs, approvals, AI traces, and audit events. Confirm a
restore preserves uniqueness constraints before replaying any external event.

## Changelog

- **2026-07-28 — v1.1:** Added normalized intake, durable provider reconciliation,
  OAuth refresh, health-budget, and approved-refund operations.
- **2026-07-28 — v1.0:** Initial integration cadence, rotation, replay, outage, and activation.
