# StoryOps Integration Architecture

**Status:** V1 provider contracts, sandbox suite, server adapters, and webhook boundary  
**Owner:** Company owner for accounts/consent; principal engineer for adapters/secrets  
**Last reviewed:** 2026-07-28

StoryOps runs fully in sandbox mode without keys. Live connections are server-only, opt-in, health
checked, and activated individually. No provider result is treated as success until the provider
returns an authoritative ID and state.

Every outbound adapter uses the same two-switch activation: its provider mode
must be `live` and its explicit capability enable flag must be `true`.
Credentials are an additional gate. Either switch alone resolves to
`disabled`, and an explicit `MODE=disabled` never falls through to sandbox
receipts. Signed inbound lead intake is the documented mode-only exception
because it receives events rather than calling a provider.

The authenticated field-media data plane is not a provider toggle. Selecting
`VITE_STORYOPS_DATA_MODE=supabase` makes private `job-media` Storage RLS,
immutable browser upload/read-back, and `field-media-finalize` mandatory. The
separate `SIGNED_STORAGE_TARGETS_*` switches activate only optional
server-issued signed upload/download targets.

## Provider matrix

| Capability       | Implemented boundary                                                                   | No-key behavior                                     | Remaining manual YELLOW live gate                                        |
| ---------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| OpenAI           | `StructuredModel`; Node/Edge Agents SDK, separate vision gate, durable run budgets     | Deterministic structured result, no proposed action | Credentials, model/vision evals, spend/redaction canary                  |
| Twilio SMS       | `TwilioSmsProvider`; current-consent and durable-rate policy, signed status callbacks  | Consent/rate/idempotency sandbox ledger             | Owned number, registration/legal review, delivery/opt-out canary         |
| Twilio voice     | `TwilioVoiceProvider`; owned From number, HTTPS TwiML, signed callbacks                | Validates HTTPS TwiML URL; sandbox queue            | Number/recording policy, call-state canary                               |
| Email            | `HttpEmailProvider`; token-authenticated HTTPS endpoint, signed status callback        | Consent/rate/idempotency sandbox ledger             | Sending-domain/provider setup, bounce/complaint/suppression canary       |
| Stripe           | `StripePaymentsProvider`; customer mapping, billing validators, signed reconciliation  | Deterministic checkout/invoice/refund artifacts     | Account, tax/accounting review, callback and money canary                |
| Google Calendar  | `GoogleCalendarProvider`; allowlisted ID, OAuth refresh, free/busy, hold/booking       | Local holds/bookings labeled sandbox                | OAuth grant/redirect, conflict and token-refresh canary                  |
| Maps/geocoding   | `GoogleMapsProvider`; validated address/coordinates/place ID                           | Explicit precision `unknown`, confidence `0.1`      | Restricted key/quota and human-precision canary                          |
| NWS              | `NwsWeatherProvider`; validated points/forecast/alerts, explicit unknown periods       | Never fabricates weather                            | Monitored User-Agent, outage/staleness canary                            |
| VROOM            | `VroomRoutingProvider`; finite timeout, HTTPS/auth guard, route completeness checks    | Deterministic custom-matrix plan                    | Private engine/router backend, capacity and dispatcher-acceptance canary |
| Core field media | Private RLS upload/read-back, actual-byte SHA-256, trusted finalizer, immutable object | IndexedDB/local packet; zero Storage requests       | Hosted Auth/RLS/finalizer/device-loss and tamper canary                  |
| Signed targets   | `SupabaseStorageProvider`; scoped short-lived server-issued upload/download targets    | `sandbox://` targets for client interception        | Optional adapter activation and signed-target expiry canary              |
| QuickBooks       | `QuickBooksCsvProvider`; formula-safe escaped CSV and SHA-256                          | Produces reviewable CSV only                        | Accountant mapping/import acceptance; no API posting                     |

Implementation is not a claim of live connectivity. A capability stays
`not_configured`/`disabled` until its explicit enable flag and required
server-only settings are present; configured status is still only `degraded`
until a bounded active probe succeeds. No real provider credential or external
canary was supplied for this release. Sandbox receipts always include
`mode: "sandbox"`.

## Shared guarantees

StoryOps correlation/idempotency keys are derived from authenticated server execution context rather than model
payload. Every provider exposes a health contract with
provider, capability, mode, status, latency, message, and required environment names. Secrets are
never included in this response.

Provider methods accept an `AbortSignal`. Transient network, rate-limit, and 5xx failures are typed
retryable. Authentication, validation, consent, and payload conflicts are not retryable.

Money crosses provider boundaries as base-10 strings with two decimal places and `USD`. Pricing
calculation happens before the provider call in the deterministic pricing engine. Providers sum
already-approved line items; they do not ask an LLM for an amount.

Live SMS, voice, and email submission reloads the exact consent snapshot, proves it is still the
latest grant for the same subject/channel/purpose, binds the stored contact to the recipient, checks
do-not-contact suppression, and consumes durable company/contact rate windows. An Edge restart
does not reset those limits.

## Normalized lead intake

`lead-intake` is the write boundary for web, chat, email, SMS, and voice leads:

1. web/chat/email accepts schema-versioned JSON signed with timestamped HMAC;
2. SMS/voice accepts the bounded form and validates the Twilio signature over the configured
   canonical URL;
3. live company scope comes from endpoint configuration and must match the signed event;
4. the parser normalizes identity/contact, source, requested services, message, consent assertions,
   and event time without treating the body as instructions;
5. durable event and idempotency claims reject a same-ID/different-payload replay;
6. company/contact limits apply before domain writes; and
7. deterministic IDs persist or extend the lead, communication thread/message, and consent records.

Sandbox intake is loopback/local-Supabase only and additionally requires the explicit sandbox
header. A missing consent assertion is recorded as `unknown`, never inferred as granted.

## Consent, opt-out, and quiet hours

Consent is recorded per contact and channel, split between transactional and marketing purposes.
Sending requires the exact current consent snapshot ID; a stale snapshot blocks the send.
Live server adapters do not receive direct access to consent or contact tables. They pass the
company, channel, purpose, exact snapshot ID, and SHA-256 of the normalized destination to the
service-role-only `authorize_outbound_contact` RPC. The database returns only an allow/deny code
and consent evidence IDs after checking the latest grant, customer suppression, and a
database-computed destination fingerprint; it never returns a phone number, email, or subject ID.

Inbound SMS recognizes standard STOP-like and START-like keywords. After signature verification,
StoryOps normalizes `From`, stores only its SHA-256 fingerprint in the durable receipt, and asks the
database to resolve exactly one company customer or lead by a database-computed fingerprint. STOP
atomically sets a matched customer’s `do_not_contact`, appends withdrawn SMS consent for both
transactional and marketing purposes, and records a redacted provider audit. A missing or ambiguous
subject fails closed. START never clears suppression or grants consent: it appends `unknown`
review-required records for both purposes. A reviewed grant is required before outbound policy can
send again. Raw sender and message body are never stored in the webhook receipt. The current Twilio
policy requires informed consent, retained proof, a straightforward one-step opt-out, and no later
messages after withdrawal except the permitted confirmation; this is not a substitute for legal
review. See [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy) and
[Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).

The default helper treats 8:00 PM–8:00 AM in the customer’s configured IANA timezone as quiet
hours. Campaign policy may be stricter. Phone area code is not a reliable timezone; use the
property/contact timezone.

**Legal review required:** TCPA, FCC, CTIA/carrier rules, state law, message category, consent
language, retention, calling hours, and A2P registration must be reviewed for the actual launch
workflow.

## Webhook boundary

`provider-webhook` performs these steps in order:

1. enforce POST and a 1 MB body limit;
2. select the explicitly supported provider;
3. validate the signature over the raw body/canonical URL;
4. parse only after validation;
5. require a stable provider event ID;
6. SHA-256 the exact payload;
7. call service-role-only `claim_webhook_event`;
8. obtain the durable processing lease;
9. pass only a finite, redacted receipt to `reconcile_provider_webhook`;
10. apply the company/reference/amount/status transition atomically; and
11. mark the event processed/ignored, or persist a bounded failure code.

Stripe events reconcile local invoice/payment/refund state only when StoryOps metadata, stable
provider IDs, USD integer amounts, and local deterministic records agree. Twilio/email callbacks
reconcile one outbound communication by provider message ID; opt-in/out signals update the matching
contact’s consent/suppression state without storing message bodies or raw contact data. Reusing an
event ID with a different payload is a conflict and incident signal. A completed/ignored or
currently processing duplicate returns a no-op receipt and does not apply a second transition.

Stripe warns that signature verification requires the untouched raw request body; see
[Stripe webhook signatures](https://docs.stripe.com/webhooks/signature). Twilio signs requests
using the configured URL and request parameters; reverse proxies can change the apparent scheme or
host, so StoryOps requires the canonical public URL in `TWILIO_WEBHOOK_URL`. See
[Twilio webhook security](https://www.twilio.com/docs/usage/tutorials/how-to-secure-your-servlet-app-by-validating-incoming-twilio-requests).

## Provider-specific notes

### OpenAI

- Live use is an explicit three-part gate; key presence alone does not activate it.
- The model name is explicit rather than guessed.
- Agents SDK code exists only in Node/Edge server adapters.
- Structured output is validated again in application code.
- SDK trace spans omit sensitive inputs/outputs; application traces are redacted.
- Tools remain outside the SDK model run and execute only after StoryOps policy.

### Twilio and email

- A provider-accepted message is not the same as delivered.
- Sandbox adapters may reconcile synthetic queued/delivered states in their
  local ledger, but make no network call and never prove customer contact or
  provider delivery. Live delivery evidence comes only from verified callbacks
  or provider reconciliation.
- Sandbox duplicate sends reuse the original receipt when the request hash matches.
- Twilio Message creation is not treated as provider-idempotent. The post-service worker commits a
  `submitted_unknown` boundary before a live create call and never automatically resends an
  ambiguous outcome; an authoritative SID is retained when available for callback/manual
  reconciliation.
- Live post-service marketing email remains disabled until signed unsubscribe and durable
  suppression/bounce/complaint handling are implemented and canaried.
- Current consent, recipient binding, suppression, and durable company/contact rates run before
  provider submission.
- Voice call creation requires an HTTPS instruction URL.

### Stripe

- Checkout, invoice, payment, and refund are distinct typed states.
- The system never marks an invoice paid from a redirect or customer statement.
- Refund requests require an approval ID and orchestrator exact-payload approval.
- Webhook events, not success-page navigation, reconcile payment state.
- Provider IDs and event IDs are persisted for replay safety.
- Live server code has no direct customer or provider-mapping table access.
  `resolve_stripe_billing_identity` returns only the exact customer ID, normalized billing
  name/email, optional mapping, and an opaque identity fingerprint. A new mapping can be written
  only through `save_stripe_customer_mapping` while that fingerprint is still current.
- Mapping retries are idempotent; provider IDs cannot be reused across company customers. Billing
  email snapshots are removed from audit payloads while the audit retains a source hash.

### Google Calendar

Read free/busy before creating a hold or booking. Holds are tentative and expiring. Confirmed
bookings require an authoritative returned event ID. Google documents that caller-supplied event IDs
can prevent duplicate creation after ambiguous failures; see
[Create events](https://developers.google.com/workspace/calendar/api/guides/create-events).

The adapter allows one configured operations calendar. It uses a short-lived access token for local
diagnostics or refreshes access with the configured OAuth client/secret/refresh token, caches only
until shortly before expiry, and retries once after an authenticated 401. Deterministic event IDs
come from the server idempotency key. This implementation does not prove the production OAuth
grant, redirect, token rotation, calendar ownership, or conflict canary.

### Maps

Store normalized address, coordinates, provider place ID, precision, confidence, and observation
time. Low confidence does not become a route input without human correction. Sandbox coordinates
are synthetic and forbidden for dispatch.

### NWS

The live adapter calls `/points/{lat},{lon}`, follows the returned hourly/forecast URL, and checks
active alerts for the point. It filters periods to the job window and preserves missing values as
unknown. Configure a descriptive User-Agent with monitored contact per
[NWS API documentation](https://www.weather.gov/documentation/services-web-api).

Weather is a decision input, not an automatic safety instruction. Missing/stale forecasts, alerts,
or unsafe conditions route to owner review.

### VROOM

The live adapter sends coordinates in longitude/latitude order, converts ISO windows to Unix
seconds, maps internal string IDs to VROOM integers, and maps routes/unassigned jobs back. A
configured endpoint with no health endpoint reports degraded—not healthy. VROOM remains an
independent service; its project documentation is at
[VROOM-Project/vroom](https://github.com/VROOM-Project/vroom).

### Storage

Core field evidence in authenticated Supabase mode does not use the optional
signed-target activation. The assigned user uploads an immutable,
content-addressed object through private bucket RLS. The browser reads the
object back and hashes it; `field-media-finalize` independently downloads under
the same user authorization, hashes the actual bytes, then crosses a
service-only database finalizer that rechecks membership, assignment, active
visit lifecycle, exact associations, object metadata, command identity, and an
unconsumed checksum attestation. A direct authenticated `media.register`,
direct table DML, or overwrite is rejected. Completion stays pending on any
missing, ambiguous, tampered, or failed dependency.

The optional server adapter issues object-key-scoped, content-type-bound,
byte-bounded, short-lived targets only when both
`SIGNED_STORAGE_TARGETS_MODE=live` and
`SIGNED_STORAGE_TARGETS_LIVE_ENABLED=true`. Private download targets expire.
Supabase documents its signed-upload behavior at
[createSignedUploadUrl](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl).
File authorization must be checked before URL issuance; a signed URL is itself a credential.

### QuickBooks export

The V1 integration creates a CSV with escaped fields, deterministic line amounts, and SHA-256. The
owner reviews and imports it. It never logs into QuickBooks, changes a vendor, moves money, or
claims reconciliation success.

## Integration health

Health is shown per capability, not as one green “integrations” light:

- `healthy`: active probe or sandbox provider succeeded;
- `degraded`: configured but incomplete/stale/no active probe;
- `down`: active probe failed; and
- `not_configured`: live mode is disabled or required server configuration is
  missing.

The aggregate status is the worst optional-provider status. Sandbox health
explicitly says it used no network or credentials. In Supabase mode only active
owners/dispatchers can trigger probes, and a durable per-user hourly budget
prevents unbounded billable checks. The signed-target probe must never be
presented as proof that core field Storage/finalization works; that data plane
passed its local authenticated actual-byte release canary. A hosted
physical-device canary remains pending. Run health after secret rotation,
provider incident recovery, OAuth reconnection, and deployment.

## Secrets

- Store secrets only in local `.env` ignored by Git or the deployment secret manager.
- Use service-role credentials only in trusted Edge/server code.
- Browser variables must never contain provider API keys.
- Do not put secrets in integration configuration JSON, approval payloads, traces, audit before/
  after snapshots, webhook errors, screenshots, or support tickets.
- Rotate a secret after suspected exposure and follow the incident playbook.
- Prefer restricted provider keys and the minimum OAuth scopes.

## Reconciliation rules

- Communication: submitted → provider receipt → callback/delivery state.
- Payment: checkout/invoice created → provider event claimed → payment row reconciled.
- Calendar: local hold/visit → returned event ID/etag → periodic exception reconciliation.
- Core field media: immutable upload → user read-back → Edge byte checksum →
  service finalizer/attestation → asset record → dependent completion.
- Optional signed targets: target issue → authorized client use → object
  reconciliation by the owning workflow.
- Accounting: exported set + checksum → owner import → bookkeeping reconciliation.

Never reconcile by count alone. Match stable provider IDs and company/entity references.

An approved action is not a reconciliation shortcut. V1’s only external resume endpoint supports
`payments.refund`, requires an authenticated owner, atomically leases the exact unexpired approval,
rechecks current eligible payment state and amount, and records/replays one provider receipt. An
ambiguous provider result remains failed/pending reconciliation with the same idempotency key.

## Launch gate

Before enabling any live adapter:

- [ ] sandbox golden path passes;
- [ ] provider test/sandbox account passes;
- [ ] health screen reports the expected mode;
- [ ] webhook signature failure and duplicate replay tests pass;
- [ ] canonical webhook URLs are configured;
- [ ] consent language and opt-out are legally reviewed;
- [ ] restricted keys/scopes are confirmed;
- [ ] rate and spend limits are set at the provider;
- [ ] delivery/payment/calendar reconciliation is observed end to end;
- [ ] rollback is “disable adapter,” not “delete data”; and
- [ ] owner knows the provider console manual recovery steps.

Before enabling authenticated Supabase field work, separately prove the
private bucket RLS matrix, assignment-scoped upload/read, denied overwrite,
actual-byte tamper rejection, direct-RPC/DML denial, exact replay, offline
restart/recovery, finalizer outage behavior, and completion dependency gate.

These are manual gates. The repository’s sandbox, unit, database, Edge typecheck, and mocked live
adapter tests do not satisfy an external provider canary.
