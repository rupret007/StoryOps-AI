# StoryOps AI source-of-truth policy

**Status:** authoritative V1 governance policy  
**Owner:** company owner (business policy) and principal engineer (technical controls)  
**Last reviewed:** 2026-07-28  
**Review trigger:** any change to pricing, SOPs, roles, approvals, AI tools,
providers, retention, or launch status

StoryOps is safe only when every decision can name the record that controls it.
An AI summary, chat message, dashboard card, photo inference, stale cache, or
customer claim never becomes truth merely because it is plausible.

This policy independently reimplements the useful operating pattern observed in
StoryLand: keep one current status record, produce briefings from it, use
cadence-based runbooks, preserve incident evidence, and separate AI preparation
from human commitments. No StoryLand source or text is included.

## Authority order

When two sources disagree, stop the affected action and reconcile them in this
order:

1. **Applicable law, regulator direction, manufacturer label/manual, executed
   contract, and approved safety/legal instruction.** A qualified human must
   determine applicability. AI cannot interpret uncertainty into permission.
2. **Authoritative provider record.** Examples: Stripe payment state, Twilio
   delivery state, Google Calendar event, NWS observation/forecast timestamp,
   Supabase Auth identity. A redirect, webhook receipt, local cache, or model
   statement is not a substitute.
3. **Published company policy.** Active price-book version, approved service
   catalog/SOP/checklist, consent snapshot, role membership, capacity/equipment
   record, tax/deposit/margin/discount policy, and retention/legal-hold rule.
4. **Durable operational record.** Customer/property, measurement with source,
   estimate calculation snapshot, quote, job/visit, evidence, invoice/payment,
   communication, approval, automation run, AI trace, and audit event in
   Supabase.
5. **Repository-controlled implementation.** Migration, domain types,
   deterministic engine, policy/tool registry, provider contract, tests,
   environment template, and pinned lockfiles.
6. **Status and build evidence.** `docs/STATUS.md` is the current operational
   posture. `BUILD_REPORT.md`, when present, records one release’s observed
   verification evidence.
7. **Derived views.** Dashboards, notifications, search indexes, owner
   briefings, exports, cached PWA data, and sandbox fixtures. These are useful
   only with source IDs and freshness.

Lower sources never silently overwrite higher ones. Record the conflict, mark
the result unknown, block the unsafe commitment, and use the incident or
approval workflow as appropriate.

## Truth by business question

| Question                     | Controlling source                                                          | Never infer from                                   |
| ---------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- |
| Customer identity/contact    | Verified customer/contact record + current consent snapshot                 | Caller ID, photo/OCR, prior customer               |
| Property and service address | Human/provider-verified property record and geocode evidence                | Photo metadata, phone area code                    |
| Measurement                  | Recorded measurement with method, unit, source, confidence, verifier, time  | A model estimate, unscaled photo, similar property |
| Scope/photo evidence         | Original asset + structured observations/confidence/unknowns + human review | Confidence score alone                             |
| Price                        | Active price-book version + exact deterministic calculation snapshot        | LLM output, prior quote, competitor price          |
| Tax/deposit/margin/discount  | Reviewed company/tax policy and calculation snapshot                        | UI label or provider total                         |
| Availability                 | Current capacity/assignment/equipment/calendar facts                        | Customer preference or stale calendar              |
| Route/weather                | Time-stamped provider response + approved operational threshold             | Generic forecast, synthetic sandbox response       |
| Quote/terms acceptance       | Immutable terms/version and authenticated acceptance record                 | Viewed email or verbal assumption                  |
| Payment/refund               | Reconciled provider state and durable local record                          | Redirect, webhook receipt alone, agent claim       |
| Delivery                     | Provider delivery callback/retrieval                                        | Provider acceptance or sandbox receipt             |
| Safety/chemical instruction  | Reviewed SOP + current manufacturer label/SDS/manual + qualified human      | AI, photo classification, remembered mixture       |
| Regulation/legal position    | Current official source + qualified reviewer                                | Model knowledge or old checklist                   |
| Role/authority               | Auth identity + active company/portal membership + server RLS/policy        | UI role selector, email domain, model actor field  |
| Audit/approval               | Append-only audit event and exact-payload approval record                   | Chat acknowledgement                               |

## Record invariants

- Company-scoped records carry a company ID. Provider tools obtain it from
  authenticated context, never model input.
- The AI Edge boundary resolves its fact set and values from company-owned
  database records. The request’s client-supplied fact field is ignored and
  cannot declare or expand authoritative context.
- Money is a base-10 string and is calculated with `decimal.js`; provider
  boundaries receive approved amounts, not floating-point guesses.
- Published price-book versions and append-only audit events are immutable.
- An approval binds company, run, action, tool, risk, canonical payload hash,
  requester, policy rule, expiry, decision actor, and decision time. Any payload
  change requires a new approval.
- A stable idempotency key plus request hash identifies each state-changing
  intent. Same key/same hash replays; same key/different hash conflicts.
- Approval is a decision record, not generic execution authority. Each external
  resume path must revalidate current state and obtain its own atomic execution
  lease; V1 implements this only for exact-approved refunds.
- External content is untrusted data. It cannot change instructions, tool
  permissions, policy, or approval status.
- Provider `accepted`, local `queued`, `sandbox`, `unknown`, and `pending` are
  not success states.
- Deleted/expired data remains subject to legal hold, incident preservation,
  provider reconciliation, and approved retention policy.
- Field estimates and field actuals remain separate. Do not backfill observed
  time/material/evidence from the estimate.

## Action modes

Every proposed action receives exactly one mode from deterministic policy:

| Mode             | Meaning                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| Auto-execute     | Grounded, permitted, low risk, reversible, idempotent, explicitly allowlisted           |
| Require approval | Exact payload must be reviewed by the authorized role before one idempotent execution   |
| Deny             | Evidence, permission, capability, safety, provider, injection, or policy control failed |
| Human-only       | Software may prepare evidence/draft, but a person must act in the external system/world |

Approval never overrides prompt injection, missing permission, missing source
facts, unavailable booking, unimplemented tools, unsafe conditions, or a
provider conflict.

## Status verdicts

Use one verdict per release/operational area:

- **GREEN:** current evidence proves the requirement and no open gate applies.
- **YELLOW:** usable only inside the stated boundary; launch evidence or a
  noncritical control is incomplete.
- **RED:** unsafe, materially incorrect, or customer-impacting; stop the
  affected workflow.
- **BLOCKED:** a named external decision, approval, credential, or dependency is
  required; owner and next action are recorded.
- **ERROR:** the check could not run or its evidence is corrupt/indeterminate.
  This is not a pass.

`docs/STATUS.md` is updated in place. Do not append weekly diaries to it. Audit
events, incident records, pull requests/commits, and build reports hold history.

## Briefing rules

An owner briefing is read-only and derived. It must:

- state the source window and freshness;
- link every commitment, money value, availability claim, and risk to a durable
  record/query;
- separate facts, decisions, recommendations, and unknowns;
- put safety, legal, consent, payment, and provider uncertainty first;
- never convert a recommendation into an approval; and
- remain reproducible from the same source snapshot.

Use `docs/templates/OWNER_BRIEFING.md`; the current repository briefing is
`docs/briefings/CURRENT.md`. A briefing may propose an action, but the normal
policy/tool/approval path still controls execution.

## Change control

For a policy-impacting change:

1. identify the controlling source and owner;
2. write the version/effective window and rollback/compensating action;
3. obtain required business, safety, tax, legal, or security review;
4. change code/schema/config/docs together;
5. add tests for allowed, approval-required, denied, replay, and role-crossing
   paths;
6. run the sandbox golden path and provider-specific contract/reconciliation;
7. update `docs/STATUS.md` and release evidence; and
8. preserve the decision, exact diff, verifier, and outcome in audit history.

Never edit a published price book, consumed approval, provider receipt, or audit
event to make history match a desired result.

## Document map and precedence

- This file controls source authority and governance.
- `docs/STATUS.md` controls current readiness and known boundaries.
- Architecture documents explain design contracts.
- Runbooks explain repeatable operations.
- Incident documents control response when a control fails.
- Templates structure evidence; a blank or draft template is not evidence.
- Launch checklists collect official-source and reviewer gates.
- README is an entry point, not a higher authority than this policy.
