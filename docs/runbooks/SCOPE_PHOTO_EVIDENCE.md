# Scope Photo Evidence Runbook

**Status:** implemented customer/staff capture, private upload, review, and
measurement boundary  
**Last reviewed:** 2026-07-30

## Boundary

Scope photos are private estimating evidence, not measurements, prices, safety clearance, or work
authorization. A model response can retain observations, confidence, access/risk flags, unknowns,
and measurement candidates. Only an authenticated owner or dispatcher can create a separate
`property_measurements` record, and that command accepts no price fields.

The workflow supports:

1. Owner/dispatcher creates a property- and customer-bound checklist.
2. The mapped customer uses the authenticated portal capture panel, or an
   owner/dispatcher uses the same scoped workflow, to request a short-lived
   signed upload target. The panel exposes the exact checklist and upload state;
   it does not expose another customer's request or private object path.
3. The browser uploads one JPEG, PNG, or WebP image, at most 10 MiB.
4. The Edge finalizer downloads the stored bytes and verifies byte count, file signature, and
   SHA-256 before registering immutable media.
5. Back office may request advisory analysis. Sandbox mode returns explicit insufficiency without
   inventing visible facts.
6. Back office enters a human-confirmed measurement and service classification, or records that
   more photos/site verification are required.

Limits are enforced in both the shared request schema and database: 12 photos per request, one to
three photos per checklist item, supported image types only, and a seven-day request by default.

## Activation and secrets

- The browser uses only the public Supabase anon key.
- Storage and finalization require the existing private `job-media` bucket.
- Live vision still requires the OpenAI dual activation switches and server-only key.
- Orphan cleanup requires `SCOPE_PHOTO_CLEANUP_MODE=manual|scheduled` and an
  independent `SCOPE_PHOTO_CLEANUP_TOKEN` of at least 32 bytes. The endpoint
  rejects surrounding whitespace and reuse of the Supabase service-role,
  post-service, transactional-outbound, or scheduling-reconciliation token.
  Never expose it through a `VITE_` variable.

No OpenAI key is needed for upload, human review, or human measurement confirmation.

## Orphan cleanup

No cleanup scheduler is shipped or configured by this repository. The
deployment owner must securely configure and monitor it before enabling this
upload boundary. The reviewed V1 recurrence is every 15 minutes with
`SCOPE_PHOTO_CLEANUP_SCHEDULE_INTERVAL_SECONDS=900`. The configured interval
must exactly match the reviewed scheduler recurrence and stay within 60–3,600
seconds. Invoke `scope-photo-cleanup` with:

- `POST`
- header `Authorization: Bearer <SCOPE_PHOTO_CLEANUP_TOKEN>`
- body
  `{"companyId":"<active-company-uuid>","trigger":"scheduled","limit":50}`

Use `SCOPE_PHOTO_CLEANUP_MODE=manual` with `"trigger":"manual"` only for a
supervised one-shot recovery. A trigger that does not exactly match the
configured mode is rejected before any orphan is claimed. The service-role key
stays inside the Edge runtime and is never a network bearer for this worker.
Configure a separate scheduled invocation for every active company. Scheduled
mode rejects a missing `companyId`.

The worker atomically claims expired, unregistered upload reservations, removes only their exact
private object paths, and records success/failure. Failures become retryable after 15 minutes, up
to ten attempts. A registered media asset is never an orphan; it follows the company operational
retention window and legal-hold controls.

Alert when `failed > 0` persists across two runs or when cleanup is not invoked for more than two
hours. Investigate Storage availability and token configuration before retrying.
Each scheduled run persists a company-scoped success or failure heartbeat.
Integration Health establishes the reviewed configuration and release
generation; those heartbeats continuously refresh current queue evidence.
Failed, missing, stale, configuration-drifted, or release-drifted evidence
blocks provider launch, and this worker is live-ready only when the other three
private workers are current too.

## Recovery

- Upload succeeded but finalization timed out: retry with the same command ID and file. Exact
  durable bytes finalize once; a different payload conflicts.
- Reservation expired: select the file again to create a new command and content-addressed object.
  The expired object remains queued for cleanup.
- Analysis unavailable: continue with human review. Do not copy a candidate into pricing.
- Wrong photo or measurement: append a new asset or a superseding measurement. Registered scope
  media and confirmed photo-assisted measurements are immutable.
- Remaining access/risk uncertainty: record `site_verification_required`; do not mark evidence
  confirmed merely to unblock an estimate.

## Verification

Run:

```sh
npm run check:edge
npm test
npm run test:supabase -- --reset
```

The integration contract covers trusted-RPC denial, customer/staff isolation, exact replay and
conflict, content-addressed reservations, customer projection minimization, human confirmation,
immutable evidence, and unresolved access/risk review.
