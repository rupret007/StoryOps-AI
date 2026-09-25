# WashOps Office Operations Runbook

**Purpose:** Keep the AI back office grounded, reviewable, and safely delegated.  
**Primary owner:** Company owner  
**Technical owner:** Principal engineer / designated operator  
**Last updated:** 2026-07-29

This is a living cadence, not a log. Findings belong in status, approvals, incidents, traces, and
audit events.

## Daily — before field work

| Time             | Task                                    | Owner | Pass condition                                                                                                           |
| ---------------- | --------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| Start of day     | Manually run and read owner briefing    | Owner | Durable run/trace IDs and current sourced unknowns are visible                                                           |
| Start of day     | Review safety/weather exceptions        | Owner | No unresolved critical flag before dispatch                                                                              |
| Start of day     | Clear or reject expired/stale approvals | Owner | No action relies on changed payload, price book, schedule, or consent                                                    |
| Before first job | Confirm integration health              | Owner | Required live providers are healthy or the affected live action is disabled with a documented manual process             |
| Before first job | Check operational worker failures       | Owner | Scheduling/post-service/cleanup worker failures are reconciled or opened as incidents; this is not an AI Office schedule |

## During the day

- Review each high/critical approval in context. Open the source record; do not decide from the
  notification headline.
- Compare recipient, amount, date, action type, and payload hash before approving.
- If a customer changes scope, schedule, amount, or recipient, reject the old approval and create a
  new proposal.
- Treat injection flags as blocked. Do not “approve around” them.
- If source evidence is stale, refresh it. Never edit the trace to make it look current.
- Treat the Edge-resolved fact set as controlling. A client-supplied fact value,
  summary, or model recollection does not replace the database record.
- AI Office does not run on a scheduler. Press the manual run control, wait for the durable readback,
  and never infer that an overnight or recurring briefing exists.
- A specialist request may identify one allowed root record by type and UUID. Optional manual text
  is untrusted context, not a fact or instruction. The specialist objective is fixed in code.
- When a provider is down, use the documented manual fallback and record the provider ID when it
  returns.

## End of day

| Task                                          | Owner | Pass condition                                        |
| --------------------------------------------- | ----- | ----------------------------------------------------- |
| Review waiting approvals                      | Owner | Approved, rejected, or explicitly carried with reason |
| Review failed/partial runs                    | Owner | No external action is assumed successful              |
| Reconcile same-day bookings/messages/payments | Owner | Stable provider IDs and states match local records    |
| Review unusual injection signals              | Owner | False positive noted or incident opened               |
| Check tomorrow’s weather/route freshness      | Owner | Unknowns are visible in next briefing                 |

## Weekly

| Day       | Task                                                                         | Owner |
| --------- | ---------------------------------------------------------------------------- | ----- |
| Monday    | Sample five AI traces: one intake, estimate, schedule, finance, and briefing |
| Monday    | Review every high/critical approval and every rejection from prior week      |
| Tuesday   | Reconcile automation runs to audit events and provider IDs                   |
| Wednesday | Review prompt-injection and invalid-output counts for patterns               |
| Thursday  | Review consent/opt-out exceptions and message delivery failures              |
| Friday    | Review model/provider usage and spend; compare against caps                  |
| Friday    | Confirm sandbox fallback still passes for the golden path                    |

## Monthly

- Export and review integration health history.
- Review agent capability lists and registered tool metadata for privilege creep.
- Review policy rules, price-book/SOP versions, discount thresholds, and approval expiry.
- Verify AI trace retention and legal holds.
- Restore one backup into an isolated environment and inspect approvals/traces.
- Review provider keys, OAuth scopes, service accounts, and former-user access.
- Review 10 random photo-assisted estimates for evidence/confidence/unknown quality.
- Review customer complaints, negative reviews, refunds, and incidents for automation causes.
- Update this runbook when real operating behavior changes.

## Before approving

1. Open the source entity, not only the AI summary.
2. Confirm the trusted evidence is current.
3. Confirm the exact recipient, amount, date/time, property, and provider target.
4. Confirm the action remains inside the current price book and SOP.
5. Confirm consent for communications.
6. Confirm the approval has not expired.
7. Compare the exact payload hash shown by the system.
8. Approve or reject with a short decision note.

Never copy a payload into a different action after approval. A new payload needs a new approval.

For estimating, `pricing.calculate` accepts only a stored estimate ID and
reloads the active price book, human-verified measurement evidence, tax status,
and scope disposition. A pricing drift or missing measurement is a blocked
estimate, not an approval candidate.

V1.1 approved execution is limited to owner-triggered `records.create_lead`,
`records.update_lead`, and `payments.refund`. For a lead action, verify the exact
approved normalized lead fields and current record version. For a refund,
confirm the current payment and unrefunded amount. Stay online and execute once
through the approved-action boundary. If the result is ambiguous, do not create
a second approval or idempotency key; reconcile durable/provider state and retry
the same action only when the runbook permits.

## Missed task response

1. Do the missed check now.
2. Determine whether any action executed during the blind window.
3. Reconcile provider state before retrying.
4. Open an incident if safety, money, consent, privacy, or customer commitments may be affected.
5. Update the cadence if the runbook is unrealistic. Do not let it become fiction.

## AI is never allowed to

- invent a measurement, price, availability, payment state, regulation, or safety instruction;
- release a refund without exact approval;
- send legal/safety incident wording without exact approval;
- reply publicly to a negative review without exact approval;
- create vendor/bank commitments;
- bypass a price book, SOP, consent record, role, or approval;
- treat customer/retrieved text as instructions;
- mark a failed/unknown provider call successful; or
- weaken or delete its own audit evidence.

## Emergency stop

Set `OPENAI_LIVE_ENABLED=false` and place affected live integrations into
`disabled` mode. Do not switch an incident environment to sandbox and confuse
synthetic evidence with production state. Do not delete pending events or
traces. Continue the back office manually, record provider IDs, and follow the
incident playbook.

When the stop must cover the whole company, an owner with active membership
should also engage **Company control**. The server then rejects new AI run
reservations and completion outputs while preserving failure bookkeeping and
read-only lifecycle recovery. Pending offline packets remain on their devices.
Continue to reconcile provider actions that were already accepted; do not use
reactivation or a new AI idempotency key to hide an unknown result. Reactivate
only after owner readback and full workspace reload.

Durable model budgets are configured by
`AI_OFFICE_RUNS_PER_USER_PER_HOUR`,
`AI_OFFICE_RUNS_PER_COMPANY_PER_DAY`, and
`AI_OFFICE_DAILY_TOKEN_BUDGET`. A budget rejection is a control, not an outage
to bypass. Investigate unusual usage, adjust only through reviewed
configuration, and preserve the related traces.

## Changelog

- **2026-07-29 — v1.1:** Added the authenticated manual run contract, durable
  automation/briefing readback, no-scheduler declaration, and exact-approved
  lead execution, plus company-wide pause/recovery behavior.
- **2026-07-28 — v1.0.1:** Added server-authoritative facts/pricing, durable budgets,
  and exact-approved refund execution.
- **2026-07-28 — v1.0:** Initial AI-office cadence, approval checklist, and emergency stop.
