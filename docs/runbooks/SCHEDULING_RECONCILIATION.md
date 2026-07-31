# Scheduling reconciliation runbook

## Purpose

The scheduling reconciliation worker safely closes Google Calendar booking
attempts that did not become a StoryOps visit. It covers two durable ambiguity
windows:

1. StoryOps recorded a pre-provider booking attempt, but the provider call or
   exact read-back became uncertain.
2. Google Calendar confirmed an event, but the scheduling-evidence receipt was
   not persisted or was never consumed before expiry.

The worker source and local contracts are implemented; no hosted Google
Calendar canary has run. The worker never creates bookings. It performs exact
read-back and conditional cancellation only. Disabled and sandbox modes claim
no work and make no provider calls.

## Default and activation

The shipped default is inactive:

```dotenv
SCHEDULING_RECONCILIATION_MODE=sandbox
SCHEDULING_RECONCILIATION_LIVE_ENABLED=false
SCHEDULING_RECONCILIATION_TOKEN=
SCHEDULING_RECONCILIATION_SCHEDULE_INTERVAL_SECONDS=120
SCHEDULING_RECONCILIATION_PROVIDER_CALLS_PER_HOUR=60
STORYOPS_RELEASE_ID=
```

Live activation requires all of the following:

- `SCHEDULING_RECONCILIATION_MODE=live`
- `SCHEDULING_RECONCILIATION_LIVE_ENABLED=true`
- `GOOGLE_CALENDAR_MODE=live`
- `GOOGLE_CALENDAR_LIVE_ENABLED=true`
- `GOOGLE_CALENDAR_ID` and one supported server-side Google credential set
- `SCHEDULING_RECONCILIATION_TOKEN`, at least 32 characters, with no leading or
  trailing whitespace
- `SCHEDULING_RECONCILIATION_SCHEDULE_INTERVAL_SECONDS=120`
- `STORYOPS_RELEASE_ID`, matching the immutable running Edge release
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`

The worker token must be different from the Supabase service-role key. Generate
and store it in the deployment secret manager, for example with
`openssl rand -hex 32`. Do not place it in source control or browser
configuration.

The Edge function has `verify_jwt = false` because an external scheduler calls
it. Its own constant-time bearer-token check is mandatory and runs before body
parsing, database claims, or provider access.

## Scheduler

No scheduler is shipped or configured by this repository. The deployment owner
must configure, secure, monitor, and rehearse it before claiming reconciliation
runs automatically. Once approved, invoke
`POST /functions/v1/scheduling-reconciliation` every two minutes. A conservative
production request is:

```json
{
  "companyId": "<active-company-uuid>",
  "batchSize": 10,
  "leaseSeconds": 90
}
```

`batchSize` must be 1–25. `leaseSeconds` must be 30–300. `workerId` is optional
and, when present, must be a UUID. Configure one invocation per active company;
live mode rejects an omitted `companyId`. Use an
`Authorization: Bearer <token>` header. Set the scheduler request timeout below
the recurrence interval and do not run a second overlapping invocation
deliberately; database leases still make overlap safe.

A completed invocation records a company-scoped successful heartbeat. Any
processing failure after the company scope is accepted records a failed
heartbeat on a best-effort basis, and either a failed or missing heartbeat
blocks provider launch. Integration Health must first establish the reviewed
configuration/release generation; subsequent scheduled heartbeats refresh
current queue evidence. All four private workers must remain current—this
worker cannot authorize launch by itself.

Start with 60 provider calls per company per hour. The configured ceiling is
1,000. Rate-limited cases move to `retry_wait`; the worker does not mutate the
provider when a budget cannot be acquired.

## Durable state model

`scheduling_calendar_booking_attempts` is the pre-provider outbox:

```text
prepared
  -> provider_unknown   provider call may have happened
  -> confirmed          exact event read-back succeeded
  -> receipt_linked     exact scheduling receipt persisted
  -> consumed           atomic visit booking won

prepared/provider_unknown/confirmed/receipt_linked
  -> cancelled          exact cleanup confirmed
  -> manual_required    identity, etag, or state no longer matches
```

Only one active attempt may exist for a company, job, and job version, even when
concurrent requests use different idempotency keys. Event IDs are deterministic
from the provider idempotency key.

`scheduling_reconciliation_cases` is the autonomous queue. A receipt insert
creates or updates a case due at receipt expiry. Receiptless outbox attempts are
also claimable, so cleanup does not depend on a future scheduling request.

`scheduling_reconciliation_attempts` records each leased worker outcome.
Claim tokens are service-only and are not exposed to staff reads.

`scheduling_equipment_reservations` holds specific physical assets for the exact
candidate interval. A successful visit booking consumes those holds. Confirmed
calendar cleanup releases them. The database exclusion constraint prevents one
asset from being held or consumed by overlapping jobs.

## Outcome interpretation

- `cancelled`: exact event absence/cancellation is confirmed; associated held
  equipment is released.
- `no_action`: the receipt was consumed by atomic visit booking; no provider
  cancellation occurred.
- `retry_wait`: no provider mutation was attempted or a safe retry is scheduled.
- `provider_unknown`: a provider request may have succeeded, or a lease expired
  after provider access; the next attempt must read exact provider state first.
- `manual_required`: event identity, private properties, window, status, or etag
  conflicted, or the retry ceiling was reached. Automation stops for the case.

Never interpret an HTTP 2xx worker response as proof that every item was
cancelled. Inspect `counts` and each result's
`calendarCancellationConfirmed`, `externalStateUnknown`, and
`manualReviewRequired`.

## Monitoring

Alert on:

- any `manual_required` result;
- `provider_unknown` older than ten minutes;
- due `pending` or `retry_wait` cases older than ten minutes;
- repeated `RATE_LIMIT_UNAVAILABLE`, `LIVE_CALENDAR_NOT_ENABLED`, or HTTP 401;
- a scheduler invocation with no successful run for five minutes.

Service-side diagnostic query:

```sql
select
  status,
  count(*) as case_count,
  min(coalesce(next_attempt_at, created_at)) as oldest_due_at
from public.scheduling_reconciliation_cases
where status in ('pending', 'leased', 'retry_wait', 'provider_unknown', 'manual_required')
group by status
order by status;
```

V1.1 does not project this queue in a staff UI or grant browser roles direct
table access. The bounded service-side diagnostic query above exposes no claim
credentials and does not authorize mutation; monitoring must run in the
reviewed operator environment.

## Manual-required procedure

1. Set `SCHEDULING_RECONCILIATION_LIVE_ENABLED=false` if failures suggest a
   systemic provider/configuration issue. Confirm the worker returns
   `status: inactive` and `claimed: 0`.
2. Open an incident. Record the StoryOps case ID, attempt ID, job ID, calendar
   ID, deterministic event ID, expected window, expected etag, and error code.
   Do not copy customer details into the incident unless required.
3. In Google Calendar, retrieve that exact event ID from the configured calendar.
   Verify its StoryOps private properties, time window, status, and current etag.
   A title or customer name is not sufficient identity evidence.
4. If any identity field differs, do not delete the event. Escalate for database
   and provider review.
5. If identity is exact and StoryOps has no consumed visit, cancel the exact
   event with the observed etag under the incident/change approval. If a visit
   exists, retain the event and investigate the booking-versus-cleanup fence.
6. Release equipment only after exact calendar cleanup is confirmed and no visit
   consumed the reservation. Preserve the incident and audit evidence.
7. Resolve durable state through an approved service-role repair transaction;
   never edit browser-visible tables or bypass the audit trigger ad hoc. Re-run
   the SQL reconciliation contract against a restored copy before a novel repair.
8. Re-enable the worker only after the cause is understood and a dry invocation
   returns no unexpected claims.

## Recovery and rollback

The immediate rollback is the scheduling-specific live flag. Leave the durable
tables and queue intact; they are the evidence needed for recovery. Disabling
Google Calendar independently also prevents claims and returns
`LIVE_CALENDAR_NOT_ENABLED`.

After an outage:

1. Restore provider credentials and confirm integration health.
2. Keep `batchSize` at 10 and the default provider-call limit.
3. Invoke one worker run manually and review every result.
4. Resume the two-minute schedule.
5. Increase throughput only after the queue is shrinking without
   `provider_unknown`, rate-limit, or manual-required growth.

Database backup and restore must include the three scheduling reconciliation
tables and equipment reservations. A restored environment must keep live
provider switches off until calendar identity and environment ownership are
verified.
