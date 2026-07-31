# Identity Provisioning Runbook

**Purpose:** Safely invite, link, and revoke StoryOps staff and customer portal identities  
**Owner:** Company owner; technical operator for Supabase Auth configuration  
**Last reviewed:** 2026-07-30  
**Launch status:** Required before any non-owner pilot login

## Authority and truth

The **Identity provisioning** page is the only supported owner workflow for adding or removing
company access after first-owner setup. It calls the authenticated
`identity-provisioning` Edge function. The browser receives only the public anon key and the
owner session; the Supabase service-role credential and Admin API remain inside the Edge runtime.

Each command binds and hashes all of these facts:

- company ID;
- random command/idempotency ID;
- action: `invite`, `link`, or `revoke`;
- normalized exact email;
- role: `dispatcher`, `technician`, or `customer`; and
- exact customer ID for a customer portal identity, otherwise `null`.

Owner is intentionally not a target role. Adding or transferring ownership requires a separately
reviewed ownership-recovery process. Never change the role or customer binding in Studio to work
around this boundary.

The lifecycle is deliberately literal:

| Status    | Proven fact                                                              | Not proven                                   |
| --------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `pending` | A bounded owner request or directory observation is durable              | Email submission, confirmation, or access    |
| `invited` | Supabase Auth accepted an invitation submission for the exact email      | Inbox delivery, link use, sign-in, or access |
| `linked`  | The exact auth email is confirmed and the exact tenant binding is active | Authorization outside that company/binding   |
| `revoked` | The exact tenant membership or portal binding was removed/deactivated    | Deletion of the shared Supabase auth user    |

`provider_submission_accepted` is an API-submission fact only. StoryOps always returns
`externalDeliveryClaimed=false`; the V1 provider boundary does not prove inbox delivery.
`provider_submission_unknown` means the request may have reached Supabase Auth but StoryOps could
not durably prove acceptance or rejection. It grants no local access and must never be
automatically resent.

## Server configuration

The safe default is disabled:

```dotenv
STORYOPS_IDENTITY_INVITE_LIVE_ENABLED=false
STORYOPS_IDENTITY_INVITE_MODE=disabled
IDENTITY_PROVISIONING_RATE_LIMIT_PER_HOUR=30
```

In this mode, exact directory lookup and existing-identity reconciliation can be exercised, but
the Edge function never calls `inviteUserByEmail`. The enable flag and mode are independent:
only the exact pair `STORYOPS_IDENTITY_INVITE_LIVE_ENABLED=true` and
`STORYOPS_IDENTITY_INVITE_MODE=live` can select the live adapter. A missing, misspelled,
invalid, or disagreeing value resolves to disabled. Credentials do not substitute for either
switch. Unit/Edge tests use disabled and mismatched states and assert zero invite calls.

To enable real invitation submission:

1. configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` only in the Edge secret store;
2. set `STORYOPS_IDENTITY_INVITE_REDIRECT_URL` to the reviewed HTTPS access route, for example
   `https://ops.example.com/access`;
3. set both `STORYOPS_IDENTITY_INVITE_LIVE_ENABLED=true` and
   `STORYOPS_IDENTITY_INVITE_MODE=live` in the same reviewed deployment;
4. retain `IDENTITY_PROVISIONING_RATE_LIMIT_PER_HOUR=30` or a lower reviewed positive integer;
5. deploy `integration-health`, `trusted-pilot-proof`, and `identity-provisioning` with JWT
   verification enabled and verify all three functions plus migrations are from the same commit;
6. as an authenticated owner or dispatcher, run **Integration health**. The
   `supabase_auth:identity_invitation` probe performs one bounded Admin-directory `GET`, validates
   response shape, records a deployment fingerprint and required setting names, and does not
   submit an invitation;
7. as the owner, activate the `supabase_auth` connection in **Integrations** only after its current
   environment proof is healthy. A dispatcher, service credential, or deployment switch cannot
   activate it;
8. run the trusted provider canary for `supabase_auth:identity_invitation`. Its accepted evidence
   is exactly `external_read` / `supabase_auth.admin_directory.retrieve`; no synthetic or invite
   response can mint that proof;
9. review and re-authorize controlled launch. Provider activation, disable, probe-generation
   change, health degradation, or company pause revokes or invalidates any prior launch snapshot;
10. run the disabled-mode, switch-mismatch, exact-email, owner, tenant-isolation, replay,
    disable-before-final-marker, pause, and offboarding tests; and
11. submit one controlled invitation to an operator-owned mailbox, then record receipt truth as
    “provider accepted,” not “delivered.”

Immediately before the real Admin API call, the Edge boundary proves the current deployment
fingerprint against the owner-enabled provider and controlled launch. The final database marker
then acquires the provider and launch locks, repeats that exact provider assertion with the same
fingerprint, repeats the `customer_contact` launch assertion, and rechecks the active owner. An
earlier green health screen or provider assertion is never reusable authority.

HTTP redirects are accepted only for loopback local development. Redirect credentials, fragments,
or caller-supplied redirect URLs are rejected. Never expose any server credential through a
`VITE_` variable, screenshot, browser log, or support bundle.

## Invite a new identity

1. Confirm the company is `active` and the owner workspace was freshly verified by the server.
2. Confirm the exact email and intended role out of band.
3. For a customer role, select the exact existing customer record. Never infer the customer from
   name, email similarity, invoice, or property.
4. Choose **Invite or locate** and submit once.
5. Interpret the result:
   - `invite_delivery_disabled`: no external submission occurred;
   - `existing_identity_requires_link`: an exact auth user exists and no invitation was sent;
   - `invite_submission_accepted`: Supabase accepted submission; delivery/access remain unknown;
   - `invite_submission_failed`: the provider rejected submission and no access was granted; or
   - `invite_submission_unknown`: submission may have happened, no access was granted, and an
     operator must reconcile the exact email in Supabase Auth before using a new command.
6. Ask the recipient to complete the provider confirmation flow. Do not mark them linked based on
   a message, screenshot, or browser state.
7. Refresh, then use the explicit link workflow.

A replay with the same command ID and exact request returns the original receipt. Any changed
request under that command ID conflicts. Use a new command only for a genuinely new owner action,
not to conceal an uncertain provider result.

## Link a confirmed identity

1. Re-enter or prepare the exact email/role/customer binding from the target row.
2. Choose **Link confirmed identity**.
3. The Edge boundary searches the privileged directory for an exact normalized email. It never
   returns a directory list to the browser.
4. The database independently checks the exact `auth.users` ID/email and requires
   `email_confirmed_at`.
5. Immediately before granting access, the RPC rechecks:
   - service-role JWT claim;
   - same company;
   - company status `active`;
   - requesting user is a current active owner;
   - permitted target role;
   - exact customer belongs to the same company and is not blocked; and
   - an existing company membership does not have a conflicting role.
     The company and owner-membership rows remain share-locked through the transaction, so a
     concurrent pause or owner offboarding either commits before the access change and blocks it, or
     waits until the already-authorized change commits.
6. Customer linking creates only the selected customer portal mapping. Staff linking never accepts
   a customer ID.
7. Confirm the receipt says `linked`, with membership active and, for customer, portal mapping
   active.

An unconfirmed or missing identity remains `pending`; no membership is created.

## Revoke and offboard

Use **Revoke exact binding** as soon as a person no longer needs access. The final RPC repeats the
active-company/active-owner check immediately before the change.

- Dispatcher or technician: deactivate the exact company membership. Historical crew assignment
  rows remain for audit, but field authorization requires an active membership and therefore fails
  closed.
- Customer: remove only the exact customer portal mapping. Deactivate the customer membership when
  no other portal mapping remains.
- Shared auth identity: do not delete or globally ban it. The same Supabase user may belong to a
  different company or another permitted customer binding.

After revocation:

1. refresh identity state and verify `revoked`;
2. verify membership/portal truth in the page, not from cached browser navigation;
3. attempt a signed-in access canary and confirm workspace/RLS denial;
4. review the immutable `identity.revoked` audit event and request ID;
5. inspect any queued field packets or active operational assignments for business disposition;
6. rotate separately shared credentials if any existed; and
7. open an incident if access persists, the exact identity is ambiguous, or provider truth is
   unavailable.

Do not delete crew, visit, job, communication, invoice, or audit history as part of access
revocation.

## Failure and incident response

| Condition                               | Safe response                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Directory unavailable or scan limit hit | Stop. Do not invite or link from a partial directory result.                              |
| Email exists but is unconfirmed         | Keep pending; recipient completes the provider flow before a new link command.            |
| Membership role conflict                | Stop and review current membership; never rewrite the role implicitly.                    |
| Company paused after request creation   | Final mutation fails; reactivate only through company-control review.                     |
| Live switches disagree                  | Keep disabled; correct the deployment and rerun the read-only probe.                      |
| Provider proof expired/degraded         | Disable invitation delivery, reconcile any unknown submission, rerun probe and canary.    |
| Provider disabled after an early check  | Final marker fails; do not bypass or retry under the stale command.                       |
| Launch was revoked or invalidated       | Final marker fails; resolve the binding change, rerun proofs, and re-authorize launch.    |
| Owner offboarded during invite call     | Persist accepted provider truth, grant no membership, and have a current owner reconcile. |
| Invite submission failed                | Preserve the failed receipt; determine provider state before retrying.                    |
| Invite submission unknown               | Do not resend. Inspect the exact Auth identity/invite state, then reconcile deliberately. |
| Suspected cross-company binding         | Pause identity changes, preserve audit evidence, and start an access incident.            |

The external invite and local access grant are intentionally separate. If the provider accepts an
invite and the owner/company changes during the distributed gap, StoryOps records that accepted
submission for reconciliation but does not silently activate membership.

For an emergency stop, set `STORYOPS_IDENTITY_INVITE_LIVE_ENABLED=false` (or
`STORYOPS_IDENTITY_INVITE_MODE=disabled`), deploy, run Integration health so the authoritative
generation becomes disabled, and use the owner **Disable** action for `supabase_auth`. If customer
contact must stop company-wide, pause the company as well. Preserve pending/unknown commands and
reconcile the exact Auth directory before any later reactivation; never resend merely because a
switch was toggled.

## Verification

Required checks before pilot:

```bash
npx vitest run \
  tests/unit/identity-provisioning-client.test.ts \
  tests/unit/identity-provisioning-panel.test.tsx

npm run check:edge
npm run test:supabase -- --reset
```

The Supabase verification manifest must include
`tests/integration/identity-provisioning.sql` and
`tests/integration/identity-invitation-provider-authority.sql`. Together they prove:

- no browser/base-table mutation surface;
- service-role JWT claim is required;
- two independent server switches and zero live calls for disabled/mismatched states;
- exact read-only environment evidence and deployment fingerprint binding;
- owner-only provider activation and idempotent replay;
- a trusted canary operation specific to Supabase Auth directory reads;
- stale Edge authority cannot survive an owner disable before the final marker;
- controlled-launch and company-pause denial;
- owner-only and tenant-isolated behavior;
- full-request idempotency conflict;
- confirmed exact staff link;
- disabled invitation truth without delivery/access claims;
- exact customer portal link and revoke;
- company-pause race denial; and
- audit evidence never claims external delivery.

Capture no real customer email, auth token, invitation link, service key, or provider response body
in screenshots or the build report.
