# Integration and provider boundaries

StoryOps runs with every provider in `sandbox` by default. A live integration is
an explicit per-provider activation, not a global “production” switch. The
integration-health screen must report `mode`, `status`, `checkedAt`, latency,
message, and missing environment names without ever returning secret values.

## Shared contract

Every adapter—OpenAI, Twilio, email, Stripe, Google Calendar, maps, NWS, VROOM,
Storage, and accounting export—must enforce the same boundary:

Before the rules below, outbound activation has three independent gates: the
provider-specific mode must be `live`, the matching explicit capability flag
must be `true`, and every required credential/configuration value must be
present. A mode-only or flag-only configuration produces a disabled adapter,
not a live adapter or sandbox receipt. `MODE=disabled` is an operational stop:
it must report `disabled` and must not fall through to synthetic sandbox
behavior.

1. Accept a typed request with company/resource IDs, actor, consent/approval
   references where relevant, and an idempotency key.
2. Validate authorization and policy before entering the adapter. The provider
   credential never expands the caller’s StoryOps permission.
3. Apply a finite timeout, provider-specific rate limit, bounded retry policy,
   and abort signal.
4. Retry only operations known to be safe/idempotent. Use the same idempotency
   key for a retry; never silently create a new business action.
5. Return a structured receipt with provider, provider ID, mode, provider
   status, timestamp, and idempotency key. “Request accepted” is not “message
   delivered,” “calendar confirmed,” or “payment paid.”
6. Write redacted audit and trace events. Never log message bodies by default,
   prompt contents, photo bytes, signed URLs, payment data, OAuth tokens, API
   keys, webhook secrets, or database URLs.
7. Treat provider responses, webhook bodies, email, SMS, transcriptions,
   attachments, calendar descriptions, reviews, and uploaded documents as
   untrusted data—not instructions to an agent.
8. Fall closed on invalid signature, stale replay window, schema mismatch,
   missing consent/approval, duplicate conflict, or indeterminate provider
   state.

### Webhook ingress

Webhook handlers must preserve the exact bytes needed by the provider’s
verification algorithm, verify before parsing or acting, enforce HTTPS in live
mode, reject oversized bodies, apply a replay window where supported, and
deduplicate the provider event ID in durable storage. The durable record should
include payload hash and processing result, not an unrestricted raw payload.

Processing is transactional:

`received → signature_valid → deduplicated → domain_transition → acknowledged`

A duplicate already completed returns a successful no-op receipt. A duplicate
currently processing must not run concurrently. A handler may acknowledge only
after the event is durably recorded; slow work goes to an idempotent background
run.

V1’s Stripe/Twilio/email handler performs the finite domain transition inside a
service-only reconciliation RPC and then marks the durable event
processed/ignored. It accepts only a redacted receipt schema: stable IDs,
company scope, event/action/status, integer provider amounts, timestamps,
bounded error codes, and hashed contact evidence where needed. It does not
persist unrestricted webhook bodies, customer content, card data, or model
instructions. Failed reconciliation records a bounded failure state for
operator review.

### Normalized lead intake

Lead ingress is separate from delivery/payment callbacks. Web/chat/email JSON
uses timestamped HMAC; Twilio SMS/voice uses its request signature and canonical
URL. The live endpoint is bound to one configured company, enforces body/time/
company/contact limits, normalizes identity/message/consent without granting
missing consent, and durably deduplicates the event before creating or extending
lead, communication, and consent records. Sandbox intake is local-stack/
loopback only and requires an explicit sandbox header. Because this boundary
receives signed inbound events and never initiates a provider call,
`LEAD_INTAKE_MODE` is intentionally mode-only; this exception does not apply to
Twilio, email, or any other outbound adapter.

## Secret boundary

- Only `VITE_` variables enter the browser bundle. `VITE_SUPABASE_ANON_KEY` is
  designed as a public client credential and still depends on RLS. No service
  role, OpenAI key, Twilio token, Stripe secret, OAuth client secret, SMTP
  password, database URL, or webhook secret may use a `VITE_` name.
- Local secrets belong in owner-only `.env.local`; production secrets belong in
  the deployment platform’s secret manager. Rotate after suspected disclosure
  and after personnel/vendor access changes.
- Provider calls needing a secret execute server-side/Edge Function-side. The
  static PWA never proxies or persists those credentials.
- Scope OAuth grants to the exact capability, use separate sandbox/live
  applications, and record grant owner and rotation/expiry.

OpenAI’s current API reference likewise says API keys are secrets that must not
be exposed in browser/app client code and should be loaded server-side from an
environment variable or key-management service:
[OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication).

## Provider activation matrix

| Provider          | Sandbox behavior                                                                                        | Minimum live environment                                                                              | Manual YELLOW evidence gate                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| OpenAI            | Deterministic structured fixture/model; no network                                                      | `OPENAI_MODE=live`, enable flag, API key, explicit model; separate vision enable/model                | Prompt/tool/vision evals, policy tests, durable budgets, redaction/spend canary |
| Twilio SMS/voice  | Synthetic queued/delivered-state reconciliation in a local ledger; no network or customer-contact proof | Live flag, account SID, auth token, owned From numbers, company/canonical webhook, Supabase           | Number ownership, registration/legal review, signature/opt-out/delivery canary  |
| Email             | Synthetic local outbox and delivery/bounce-state events; no provider-delivery proof                     | Live flag, HTTPS provider/health endpoint, token, From identity, webhook secret, Supabase             | Domain authentication, reply/bounce/complaint/suppression canary                |
| Stripe            | Synthetic local checkout/invoice/refund receipts; no funds move or provider payment is asserted         | Live flag, secret/signing keys, HTTPS return URLs, Supabase                                           | Account, signature/idempotency/reconciliation canary, accounting/tax sign-off   |
| Google Calendar   | In-memory capacity windows and holds                                                                    | Approved calendar ID plus OAuth client/secret/refresh token, or diagnostic access token               | Least-privilege grant, expiry/refresh, ownership and conflict/race canary       |
| Maps/geocoding    | Known DFW fixtures with declared precision                                                              | Live flag and restricted Google Maps key                                                              | Key restrictions, quota, precision/human-review rules and canary                |
| NWS weather       | Fixed forecast/alert fixtures                                                                           | Live flag and identifying `NWS_USER_AGENT`                                                            | Monitored contact, timeout/cache, outage and stale-data canary                  |
| VROOM             | Deterministic custom cost matrices                                                                      | Live flag, private HTTPS/loopback `VROOM_URL`; approved router backend for coordinates                | Version/health, matrix contract, timeout/capacity, manual route acceptance      |
| Core field media  | IndexedDB-scoped packet; no Supabase Storage network call                                               | `VITE_STORYOPS_DATA_MODE=supabase`, public URL/anon key, private `job-media`, finalizer               | Auth/RLS, byte checksum/tamper, overwrite denial, offline/device canary         |
| Signed targets    | `sandbox://` upload/download target                                                                     | `SIGNED_STORAGE_TARGETS_MODE=live`, explicit enable, server credentials, private bucket               | Optional target scope/expiry/use/reconciliation canary                          |
| QuickBooks export | Deterministic owner-downloadable export artifact                                                        | `QUICKBOOKS_MODE=live` and `QUICKBOOKS_EXPORT_ENABLED=true`; any API mode needs separate OAuth review | Owner approval, balanced totals, duplicate guard, accountant import acceptance  |

“Not configured” is an expected status and must not be presented as healthy.
The core golden path must remain usable in sandbox without keys.
All listed live adapters are implemented server-side; none has passed a real
credential/external provider canary in this release.

## OpenAI and agent orchestration

The project pins `@openai/agents` and uses the Agents SDK for code-first
orchestration. OpenAI’s official SDK guidance identifies agents, tools,
handoffs, guardrails, tracing, and sandbox execution as Agents SDK use cases:
[OpenAI SDKs and CLI—Agents SDK](https://developers.openai.com/api/docs/libraries#use-the-agents-sdk).

Boundary rules:

- `OPENAI_API_KEY` is server-only; a key alone never changes provider mode.
- Structured AI requires both `OPENAI_MODE=live` and
  `OPENAI_LIVE_ENABLED=true`. Photo analysis requires `OPENAI_MODE=live` and
  its separate `OPENAI_VISION_LIVE_ENABLED=true` switch.
- `OPENAI_MODEL` has no implicit live default. The owner selects and evaluates a
  currently available model before activation; StoryOps must not invent a model
  name or silently upgrade one.
- Each agent receives only the typed tools required for its role. Database,
  provider, and approval tools independently enforce identity, company, RBAC,
  policy, and idempotency.
- The Edge boundary ignores client-supplied fact values, reloads authoritative
  company facts, and lets `pricing.calculate` accept only a stored estimate ID.
  Pricing reloads the active versioned rules and human-verified measurement
  evidence and rejects any stored-total drift.
- Durable user/company/run/token windows bound model use. Restarting an Edge
  isolate does not reset those budgets.
- Structured output is schema-validated. Invalid/missing fields fail; they are
  not repaired with invented prices, measurements, availability, payment state,
  regulations, or safety/chemical instructions.
- Input and output guardrails screen prompt-injection patterns, secret
  disclosure, untrusted-instruction use, safety/legal messaging, and actions
  outside the selected price book/SOP.
- Traces correlate `traceId`, `automationRunId`, `agent`, `promptVersion`,
  `model`, tool name, policy version, approval, and provider receipt. Redacted
  traces are diagnostic records, not a second source of truth.
- Agents API requests use `store: false`; that setting does not replace the
  company’s approved retention/privacy review for application traces.
- Tool outputs, not model prose, determine price, calendar capacity, payment
  status, weather observation, and provider delivery state.
- Verify any OpenAI webhook signature before use. OpenAI documents the official
  SDK `unwrap()` verification path and server-side signing secret:
  [OpenAI webhook verification](https://developers.openai.com/api/docs/guides/webhooks#verifying-webhook-signatures).

## Twilio SMS and voice

- Validate `X-Twilio-Signature` using Twilio’s supported validator and the exact
  public URL/parameters Twilio signed. Account for trusted proxy URL
  reconstruction; never disable validation merely because TLS terminates at a
  proxy. Twilio’s official guide demonstrates the validation boundary:
  [validating incoming Twilio requests](https://www.twilio.com/docs/usage/tutorials/how-to-secure-your-servlet-app-by-validating-incoming-twilio-requests).
- Separate transactional and marketing categories. Consent snapshots are
  immutable evidence tied to channel, purpose, source text/version, subject,
  captured time, and revocation.
- Opt-out creates a durable suppression before any agent continuation. Delivery
  callbacks update provider delivery only after signature and event
  deduplication.
- Live sends reload the exact snapshot, require it to remain the latest grant
  for the same subject/channel/purpose and stored recipient, honor
  do-not-contact, and consume durable company/contact rate windows.
- Do not treat `I-Twilio-Idempotency-Token` as Message-create idempotency. The
  post-service worker commits an unknown-submission quarantine before the live
  create call; any timeout/crash/invalid-response ambiguity is excluded from
  resend and reconciled by authoritative SID/callback/account evidence.
- Call recordings/transcripts are off until counsel-approved notice, consent,
  retention, access, and deletion controls exist.
- **REQUIRED COMMUNICATIONS/RECORDING LEGAL REVIEW:** TCPA, FCC consent/
  revocation rules, federal/state do-not-call rules, Texas law, call-recording
  law for every participant location, carrier policies, and Twilio messaging
  registration must be reviewed for the actual workflow. See the current
  [FCC consent-revocation order](https://docs.fcc.gov/public/attachments/FCC-24-24A1_Rcd.pdf).

## Email

- The adapter owns provider differences; domain code sends a normalized email
  request and receives a normalized receipt.
- Live post-service marketing email is disabled until the provider has a
  verified signed unsubscribe path that durably updates suppression plus
  bounce/complaint handling. Sandbox execution is not delivery evidence.
- Live activation requires an authenticated sending domain, truthful sender and
  reply path, delivery/bounce/complaint processing, suppression, and rate limits.
- Do not embed expiring provider secrets or sensitive job-photo links. Use
  short-lived portal links with authorization at access time.
- **REQUIRED COMMUNICATIONS LEGAL REVIEW:** classify transactional versus
  commercial content, approve address/advertising/opt-out disclosures, and
  process suppression under current law. Review
  [FTC CAN-SPAM guidance](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business).

## Stripe

- Create Checkout/Invoices server-side with decimal money already calculated by
  the deterministic price engine. Stripe does not decide scope, tax
  classification, discount approval, or price-book compliance.
- Use an idempotency key for create/refund calls. A transport timeout leaves the
  action `unknown` until queried by the same provider reference/key.
- Verify the webhook against the raw request body and signing secret before
  changing invoice/payment state. Deduplicate event IDs. Stripe’s official
  guidance is
  [webhook signature verification](https://docs.stripe.com/webhooks/signature).
- Never treat redirect success, customer screenshot, email text, or model output
  as payment. Only a verified provider read/event may advance payment state.
- Refunds always require owner approval for payment, amount, reason, and
  idempotency key.
- V1’s external approved-action executor supports only `payments.refund`. It
  requires an authenticated owner, revalidates the exact persisted approval and
  current eligible payment/amount, obtains an atomic execution lease, derives
  the provider idempotency key server-side, validates the Stripe response, and
  consumes the approval only after durable completion. Ambiguous state remains
  pending reconciliation.
- **REQUIRED TAX/FINANCIAL/LEGAL REVIEW:** taxability, tax sourcing, deposits,
  invoice terms, refunds, disputes/chargebacks, surcharges, and accounting
  treatment require professional approval. StoryOps does not provide banking or
  tax advice.

## Google Calendar

- Read only the approved operations calendar(s); write only StoryOps holds/
  bookings with a StoryOps job ID and idempotency key.
- Availability is an observation with `observedAt`, source calendars, and
  timezone. Re-read immediately before committing; a stale free slot is not
  availability.
- Create expiring tentative holds before customer commitment. A provider receipt
  must confirm the booking; conflict/timeout enters reconciliation.
- Keep customer/chemical/safety detail out of third-party calendar descriptions.
- Owner changes made outside StoryOps remain authoritative and must reconcile
  without duplication.
- The adapter allowlists one configured calendar and uses deterministic event
  IDs. It can use a short-lived access token for diagnostics or refresh through
  the configured OAuth client/secret/refresh token, cache until shortly before
  expiry, and retry once after a 401. This does not prove the production OAuth
  grant or token-rotation canary.

## Maps and geocoding

- Geocoding returns candidates, precision, confidence, provider place ID, and
  observation time. It does not return property measurements or prove a
  jurisdiction.
- Low confidence/precision, conflicting municipalities, unit ambiguity, rural
  routes, or a customer correction require human verification before pricing or
  dispatch.
- Provider restrictions must bind browser/server keys to the required API,
  origin/IP, quota, and project.
- Route distance is a travel input, not an invented property dimension.

## National Weather Service

- Live calls identify the application with a monitored contact in
  `NWS_USER_AGENT`; the NWS API currently requires a User-Agent:
  [NWS API Web Service](https://www.weather.gov/documentation/services-web-api).
- Cache by endpoint/provider guidance, store `observedAt`, and surface stale/
  unavailable data. Never replace an outage with “safe weather.”
- Weather evidence may block or request approval; it never independently
  certifies ladder, roof, chemical, heat, or driving safety.

## VROOM routing service

- VROOM core is pinned to `v1.15.0` commit
  `43dd7d0b8b560431eb555bf335cf4797eb7343c4`; vroom-express is pinned to
  `v0.12.0` commit `5475901e60ec13ed9eec6cc87c811206a779eb03`.
- `infra/vroom/Dockerfile` deliberately omits GLPK. The build proves that the
  header and linked library are absent. Core route optimization and custom
  matrices remain; plan-mode ETA validation code that depends on GLPK is not
  included, and `planmode` is disabled.
- The no-key path supplies deterministic custom duration/distance matrices and
  does not contact OSRM. Coordinate-only requests require an operator-approved,
  licensed, monitored OSRM/ORS/Valhalla service configured on the private
  network.
- VROOM is advisory optimization. It cannot override crew hours, skills,
  equipment, appointment windows, weather/safety blocks, or owner constraints.
  The dispatcher accepts the route before customer commitments.
- Limit request bytes, locations, vehicles, threads, exploration, and timeout.
  Do not expose port 3000 publicly.

## Supabase Storage

- Browser access uses the public anon credential plus RLS. Service-role access is
  server/operations-only and bypasses RLS; never put it in browser code.
- In authenticated Supabase data mode, private field Storage is a mandatory
  core data plane, not an optional provider. The optional
  `SIGNED_STORAGE_TARGETS_*` switches govern only server-issued signed targets
  and must not appear as a field-readiness toggle.
- Field evidence is content-addressed and immutable. Upload uses
  `upsert: false`; authenticated overwrite and direct media/signature DML are
  denied. The browser performs a read-back check, and the authenticated
  `field-media-finalize` Edge boundary independently checks the declared
  JPEG/PNG/WebP magic and hashes the stored bytes before a service-only RPC can
  consume a one-time checksum attestation.
- The database finalizer rechecks company membership, technician assignment,
  visit lifecycle, entity associations, path/checksum binding, metadata,
  idempotency, and replay. Generic authenticated `media.register` cannot
  create synced evidence.
- Signature capture accepts only active/paused on-site work, bounds offline
  timestamps to seven days stale and five minutes future, and stores a separate
  server `received_at` timestamp.
- Store object IDs and metadata in domain records; deliver short-lived signed
  URLs only after authorization. A bucket’s `public` flag is a security decision.
- Validate maximum size, declared/detected media type, company/job ownership,
  uploader, hash, and retention class. Preserve originals used as evidence.
- Back up object bytes separately from the database. Supabase documents that
  database backups contain Storage metadata but not stored objects:
  [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups).

## QuickBooks export

- V1 creates an owner-approved, deterministic export; it does not connect to a
  bank or post autonomously to a ledger.
- Export only finalized invoices/payments with stable external IDs, balanced
  decimal totals, tax/discount/deposit detail, and a hash. Re-running the same
  export produces the same identity and cannot duplicate a journal action.
- The accountant owns account/tax-code mappings. A changed mapping versions the
  export policy and requires approval.
- Any future OAuth/API posting is a separate live provider activation with
  least-privilege scopes, reconciliation, sandbox proof, and explicit owner
  approval.
