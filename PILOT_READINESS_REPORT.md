# StoryOps AI V1.1 pilot readiness

**Assessment date:** **PENDING — root to fill after source freeze**  
**Target operator:** one owner-operated DFW exterior-cleaning company  
**First industry pack:** pressure/soft washing, gutter/downspout cleaning,
roof washing, window cleaning, and related exterior add-ons  
**Decision:** **YELLOW — suitable for a bounded sandbox/operator rehearsal;
not authorized for live customers**  
**Release evidence:** pending final source-freeze verification, fresh
screenshots, independent audit, and local release commit

## Executive decision

StoryOps AI V1.1 is a production-shaped operating system with an exterior-
cleaning starter pack, not a claim of universal industry support. The reusable
kernel owns CRM, property, deterministic pricing, approvals, dispatch, offline
field execution, billing truth, portal access, AI governance, integrations,
audit, and incident handling. The pack owns exterior service definitions,
measurements, price templates, scope evidence, equipment and operating
defaults.

The local product can be configured and rehearsed without provider keys.
Authentication, tenant isolation, finite database commands, exact approvals,
provider reconciliation, and durable evidence boundaries are implemented for a
reviewed Supabase deployment. No hosted environment, real credential, external
provider canary, real customer workflow, or professional launch approval was
provided. Those omissions are launch blockers, not test failures.

This assessment describes the current source boundary. It does not assert final
test counts, migration counts, hashes, timestamps, screenshots, backup proof, or
commit provenance. Earlier V1 evidence is not V1.1 release evidence.

## Two separate readiness decisions

| Decision boundary                 | Current decision                                                                                                                                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local product/operator rehearsal  | **READY FOR BOUNDED LOCAL REHEARSAL, SUBJECT TO FINAL SOURCE-FREEZE EVIDENCE.** The no-key sandbox and local authenticated contracts are the supported proof boundary. They may be used with synthetic identities and data; they do not authorize customer or provider work. |
| Live customer/provider operations | **YELLOW — NOT AUTHORIZED.** No hosted deployment, real credential, external canary, professional launch approval, or named production operator evidence is recorded. A passing local suite cannot turn this decision green.                                                 |

The local release record remains intentionally incomplete until the final,
byte-current source is frozen:

| Final evidence field                         | Handoff value              |
| -------------------------------------------- | -------------------------- |
| Reviewed local release commit                | **PENDING — root to fill** |
| Full command matrix and exact results        | **PENDING — root to fill** |
| Migration/schema inventory and current hash  | **PENDING — root to fill** |
| Signed isolated backup/restore proof         | **PENDING — root to fill** |
| Byte-current screenshot inventory            | **PENDING — root to fill** |
| Independent release audit and P0/P1 decision | **PENDING — root to fill** |

## What an operator can rehearse now

| Operating stage      | V1.1 evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup                | Owner configuration studio creates reviewed drafts for identity, ZIP-based service area, hours, people, equipment, materials/SDS, pricing, policies, terms, payments, engagement, and integrations. Setup completion does not publish or activate them.                                                                                                                                                                                                                      |
| Intake               | Website, chat, SMS, voice, and email normalize into the same lead/customer/property/communication/consent model, with duplicate, rate-limit, opt-out, handoff, idempotency, and injection controls.                                                                                                                                                                                                                                                                          |
| Scope                | Private bounded photo requests, a complete exterior view checklist, evidence/confidence/unknowns, human-confirmed measurements, review, retention, and orphan cleanup. A globally usable photo cannot authorize a price; one exact request/review/measurement bundle must.                                                                                                                                                                                                   |
| Estimate             | Versioned Decimal formulas cover square foot, linear foot, count, flat, and hour inputs plus classifications, minimums, ZIP travel, duration, cost/margin, tax, deposit, discount, add-ons, packages, and approval reasons. AI cannot supply measurements or prices.                                                                                                                                                                                                         |
| Quote and portal     | Policy/approval, publication, delivery-state separation, view/reject/change request, and acceptance requiring a typed signer plus affirmative acknowledgement of the exact quote version, terms version, and total. Append-only acceptance evidence, optional items, deposit/payment boundaries, appointments, consent, additional service, and recurring maintenance are projected only to the exact portal customer.                                                       |
| Booking and dispatch | Accepted quote/deposit truth, crew/capacity/equipment, work windows, current calendar receipt, route, weather, one-time evidence consumption, conflict handling, and reconciliation quarantine.                                                                                                                                                                                                                                                                              |
| Field                | Role-scoped mobile packet, offline command replay, scope/exclusions, safety, checklist, timer, materials/SDS, before/after media, notes, change request, incident, signature, and exact completion dependencies.                                                                                                                                                                                                                                                             |
| Cash and retention   | Completion-backed invoice, distinct Checkout Session and PaymentIntent identity, provider-reconciled payment/refund, retired failed/expired checkout attempts, and collection holds for verified but unapplied funds. Only an exact owner-approved current-balance conflict can use the in-app allocation resolver; other conflicts remain provider/accounting work. Consent-aware review/referral and recurring-maintenance records never assert unverified provider state. |
| AI Office            | Intake, estimating, scheduling, follow-up, marketing, finance, safety, and owner-briefing specialists use fixed objectives, server-resolved facts, typed allowlisted tools, structured output, durable runs/traces, policy decisions, exact approvals, budgets, and injection defenses. Manual owner/dispatcher runs are observable; no unattended scheduler is claimed.                                                                                                     |
| Audit                | Owners can inspect a bounded, paginated, redacted metadata feed. Raw actor IDs and before/after payloads are not exposed to browser or service roles; the feed is not represented as backup or cryptographic integrity proof.                                                                                                                                                                                                                                                |

## Exterior-service template and deterministic pricing

The repository-controlled starter pack is
`storyops-exterior-dfw-v1.1.0`; its sample policy is the versioned
`2026.07-v3` DFW Residential book. These are configurable launch inputs, not
recommended market prices or a tax/legal conclusion. The operator must review
and publish a forward version before live use.

For each service, the Decimal engine calculates:

```text
chargeable quantity = max(measured quantity - included quantity, 0)
attribute factor    = product of every required price-book multiplier
service line        = max(service minimum,
                          round cents((base + unit rate × chargeable quantity)
                                      × attribute factor))
add-on line         = round cents(add-on rate × separately measured quantity)
```

It then applies the company minimum across priced service and add-on lines,
adds the exact mapped travel-zone fee and any separately approved manual
adjustment, applies the configured discount, allocates that discount
proportionally to the taxable subtotal, calculates tax, and calculates the
deposit from the final total. Missing quantities, attributes, mappings, rules,
or effective publication state fail closed; an LLM supplies none of them.

| Service template                | Pricing input | Deterministic starter rule                                   | Required classifications                                              | Starter add-ons                                                                                                            |
| ------------------------------- | ------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Driveway/flatwork pressure wash | Square foot   | $110 base; 500 included; $0.14/sq ft after; $185 minimum     | Surface, soil, access, risk                                           | Oil spot $22/each; sidewalk $0.16/sq ft; patio $0.18/sq ft; fence $1.25/linear ft; retaining wall $0.45/sq ft              |
| House exterior soft wash        | Square foot   | $195 base; 1,200 included; $0.13/sq ft after; $249 minimum   | Stories, siding material, organic growth, access, risk                | Oxidation treatment $0.38/sq ft with owner material review; recurring-maintenance enrollment is a $0.00 non-taxable record |
| Gutter/downspout cleaning       | Linear foot   | $155 base; 100 included; $0.85/linear ft after; $180 minimum | Stories, gutter guards, roof access, debris, risk                     | Downspout flow test and flush $18/each                                                                                     |
| Roof soft wash                  | Square foot   | $275 base; 1,000 included; $0.22/sq ft after; $425 minimum   | Stories, roof pitch, roof material, roof access, organic growth, risk | None; unsupported roof conditions stop for scope/SOP review                                                                |
| Window cleaning                 | Pane count    | $85 base; 10 included; $9/each after; $149 minimum           | Stories, service side, screens, tracks, access, risk                  | None; specialty glass, storms, construction debris, and elevated access stop for review                                    |

The starter-book controls are equally deterministic:

| Control                 | Starter setting                                                                                                                    | Enforcement boundary                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Company minimum         | $225                                                                                                                               | Adds an explicit minimum-adjustment line when the combined priced service/add-on scope is nonzero and below the threshold.                                       |
| Travel                  | DFW-A $0 through 20 one-way miles; DFW-B $35 through 35; DFW-C $75 through 50; starter fees marked non-taxable                     | Estimate uses the exact owner-reviewed ZIP mapping. Unknown or ambiguous ZIP/zone state stops; mileage is not an implicit fallback.                              |
| Tax                     | 8.25% starter rate; all five starter services/add-ons except recurring enrollment marked taxable                                   | Applied only to the net taxable subtotal unless the customer has authoritative tax-exempt state. Taxability and rate require Texas professional review.          |
| Deposit                 | 25% of final total, rounded to cents and capped at total                                                                           | Quote records the exact required amount; payment truth still requires provider reconciliation.                                                                   |
| Margin floor            | 42% estimated gross margin on net subtotal excluding tax                                                                           | A result below the floor creates a blocking `margin_below_floor` approval; estimated costs remain explicit inputs.                                               |
| Automatic discount      | Up to 10%                                                                                                                          | A larger equivalent discount creates a blocking `large_discount` approval. A manual price adjustment always creates a blocking `price_exception` approval.       |
| Elevated/specialty work | Three-story, elevated risk, steep/tile roof, and oxidation treatment carry template-specific approval flags                        | Owner scope, access, material, fall-protection, and SOP review is required; no multiplier waives safe-work or jurisdiction review.                               |
| Packages                | `ESSENTIAL_CARE` (Good), `CURB_APPEAL_PLUS` (Better), `WHOLE_PROPERTY_CARE` (Best), generated deterministically from enabled scope | Every component keeps its measured service formula. Best requires an explicit measured downspout flush when gutter cleaning is included; no hidden bundle price. |

Before launch, the owner must replace or affirm every dollar, multiplier,
included quantity, duration/cost input, ZIP mapping, taxability decision,
deposit, discount, margin, package, exclusion, SDS, and SOP using reviewable
evidence. Publishing a price book does not approve unsafe work.

## Provider activation, health, canary, and manual gates

Every optional live adapter requires both its mode set to `live` and its
separate enable flag set to `true`. A mismatch is disabled, not partially live;
credentials alone grant no authority. Complete configuration is reported as
degraded until an active probe succeeds. A healthy probe proves reachability,
not a business canary; an owner-attested canary record does not itself execute
the canary. Company `active` state, current launch authority, consent/policy,
approval, and the exact pre-provider reservation remain independent gates.

| Capability                  | Activation switches                                                                             | Minimum configuration boundary                                                                                                   | Health and external-canary proof                                                                                                                         | Manual YELLOW gate                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| OpenAI structured AI        | `OPENAI_MODE=live` + `OPENAI_LIVE_ENABLED=true`                                                 | Server-only API key and explicitly selected model                                                                                | Active model probe plus representative prompt/tool/guardrail, trace-redaction, budget, timeout, and spend canary                                         | Owner approves model, prompts, tools, budgets, privacy/retention, kill switch, and incident owner           |
| OpenAI scope-photo analysis | `OPENAI_MODE=live` + `OPENAI_VISION_LIVE_ENABLED=true`                                          | Server-only API key and explicit vision model                                                                                    | Representative private-media canary proving evidence/confidence/unknowns and uncertainty escalation                                                      | Owner approves image handling and confirms that only reviewed measurements can authorize pricing            |
| Twilio SMS/voice            | `TWILIO_MODE=live` + `TWILIO_LIVE_ENABLED=true`                                                 | SID/token, owned SMS/voice numbers, canonical webhook, company binding, Supabase server credentials                              | Provider retrieval and signed callback canaries for accepted/delivered/failed/unknown, STOP, duplicate, and timeout                                      | Registration, consent/quiet-hours language, number ownership, recording/transcription, and legal review     |
| Signed inbound lead intake  | `LEAD_INTAKE_MODE=live` + `LEAD_INTAKE_LIVE_ENABLED=true`                                       | Exact company, HMAC signing secret, canonical Twilio URL, rate limits, Supabase server credentials                               | Web/chat/email HMAC and Twilio signature/replay/deduplication/STOP canaries with durable subject reconciliation                                          | Owner approves source identities, consent semantics, rate limits, handoff, and incident response            |
| Email                       | `EMAIL_MODE=live` + `EMAIL_LIVE_ENABLED=true`                                                   | HTTPS provider/health endpoint, token, From identity, webhook secret, Supabase server credentials                                | Domain-health plus signed accepted/delivery/bounce/complaint/suppression and ambiguous-send canaries                                                     | Domain authentication, approved content/consent, suppression process, and legal/privacy review              |
| Supabase Auth invitations   | `STORYOPS_IDENTITY_INVITE_MODE=live` + `STORYOPS_IDENTITY_INVITE_LIVE_ENABLED=true`             | Reviewed redirect and server-only Supabase credentials                                                                           | Read-only Admin-directory health probe, then a controlled invitation/offboarding/session canary                                                          | Active owner enables exact connection and signs identity provisioning/revocation procedure                  |
| Stripe payments             | `STRIPE_MODE=live` + `STRIPE_LIVE_ENABLED=true`                                                 | Secret/signing keys, HTTPS success/cancel URLs, Supabase server credentials                                                      | Signed webhook and retrieval canaries covering session/payment identity, expiry/replacement, late success, amount, duplicate, refund, and reconciliation | Account ownership plus accounting, tax, refund, terms, dispute, and incident approval                       |
| Google Calendar             | `GOOGLE_CALENDAR_MODE=live` + `GOOGLE_CALENDAR_LIVE_ENABLED=true`                               | Exact calendar ID and least-privilege OAuth refresh credentials or diagnostic access token                                       | Token refresh, free/busy, hold/book, race/conflict, provider-ID, and orphan-event compensation canaries                                                  | Calendar owner, scopes, operating hours/capacity, rollback, and manual scheduling fallback                  |
| Scheduling reconciliation   | `SCHEDULING_RECONCILIATION_MODE=live` + `SCHEDULING_RECONCILIATION_LIVE_ENABLED=true`           | Separate high-entropy worker token, Supabase server credentials, live Google Calendar configuration, reviewed external scheduler | Real scheduled claims plus ambiguous-read-back, conditional cancellation, lease-recovery, rate-limit, stale-worker, and no-overlap canaries              | Owner approves two-minute cadence, provider-call budget, alerting, orphan policy, kill switch, and operator |
| Google Maps/geocoding       | `MAPS_MODE=live` + `MAPS_LIVE_ENABLED=true`                                                     | Server-side restricted Maps key                                                                                                  | Restriction/quota, ambiguous-address, precision, human-review, duplicate-property, and outage canaries                                                   | Approved service area, precision thresholds, address/privacy handling, and cost limits                      |
| NWS weather                 | `WEATHER_MODE=live` + `NWS_LIVE_ENABLED=true`                                                   | Identifying monitored `NWS_USER_AGENT`                                                                                           | Forecast/alert provenance, cache/freshness, timeout, stale/outage, and weather-hold canaries                                                             | Owner approves stop/hold policy, monitoring contact, manual forecast process, and safety escalation         |
| VROOM routing               | `ROUTING_MODE=live` + `VROOM_LIVE_ENABLED=true`                                                 | Private HTTPS/loopback VROOM URL, reviewed router backend, optional authorization, finite timeout                                | Version/health, coordinate/matrix contract, capacity, timeout, infeasible-route, and stale-evidence canaries                                             | Owner accepts route manually and approves coordinate disclosure/retention, limits, and fallback             |
| Core field media            | `VITE_STORYOPS_DATA_MODE=supabase` (mandatory data-plane choice, not an optional provider flag) | Public Supabase URL/anon key and company UUID, private `job-media` bucket, assignment RLS, trusted byte-verifying finalizer      | Real-device upload/read-back/checksum/tamper/overwrite/offline-recovery/completion canary                                                                | Device, quota, lifecycle, content/malware, signed-link expiry, loss/recovery, privacy, and retention review |
| Optional signed targets     | `SIGNED_STORAGE_TARGETS_MODE=live` + `SIGNED_STORAGE_TARGETS_LIVE_ENABLED=true`                 | Server-only Supabase credentials and exact private `job-media` bucket                                                            | Target scope/expiry/single-use/read-back/reconciliation canary                                                                                           | Owner records why this optional path is needed; its health never substitutes for core field-media proof     |
| QuickBooks CSV export       | `QUICKBOOKS_MODE=live` + `QUICKBOOKS_EXPORT_ENABLED=true`                                       | No bank/vendor credential for the V1 manual export; preserve checksummed artifact boundary                                       | Balanced totals, formula-safe cells, duplicate guard, accountant test import, and rollback/reversal proof                                                | Owner approves exact export; accountant accepts mapping. No OAuth posting, bank, or vendor action           |

No row above has recorded live credential or external-canary evidence in this
release. Activation must proceed one capability at a time using
[`docs/runbooks/INTEGRATION_RUNBOOK.md`](docs/runbooks/INTEGRATION_RUNBOOK.md)
and
[`docs/compliance/PROVIDER-BOUNDARIES.md`](docs/compliance/PROVIDER-BOUNDARIES.md).

## Pilot release gates

| Gate                                                  | Local posture                                                                                                                                     | Live requirement                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product and deterministic rules                       | Implemented and locally testable                                                                                                                  | Operator validates every enabled service, formula, minimum, duration, exclusion, package, travel ZIP, tax, deposit, and margin rule against real jobs.                           |
| Identity, RBAC, and tenant isolation                  | Auth/RLS/RPC contracts implemented                                                                                                                | Hosted cross-role and cross-company canary; production invitation/offboarding/session procedure approved.                                                                        |
| Scope and field media                                 | Private Storage and exact evidence contracts implemented                                                                                          | Hosted device, quota, lifecycle, malware/content process, signed-link expiry, loss/recovery, and representative-media canary.                                                    |
| Scheduling                                            | Durable calendar/route/weather/equipment receipt and compensation contracts implemented                                                           | Approved Google calendar, maps, NWS, and VROOM configuration; fresh provider canary; orphan-event compensation drill.                                                            |
| Communications                                        | Consent, opt-out, webhook, receipt, ambiguity, and reconciliation boundaries implemented                                                          | Owned Twilio/email identities, registration/domain controls, approved language, signed callbacks, delivery/STOP/bounce/complaint canaries.                                       |
| Billing                                               | Checkout/invoice/payment/refund interfaces, checkout retirement, allocation quarantine, and exact approved current-balance resolution implemented | Stripe account/configuration, tax/accounting review, signed webhook, expiry/replacement/late-success, amount/idempotency/reconciliation canaries; no real card data in StoryOps. |
| AI                                                    | Sandbox and disabled-without-key modes, guarded server execution, evaluations, budgets, and redacted traces implemented                           | Model/privacy review, approved prompts/tools/budgets, representative staged canary, monitoring, kill switch, and incident owner.                                                 |
| Backup and restore                                    | Local logical DB/roles/blobs backup and checksum/restore dry-run tooling implemented                                                              | Encrypted off-site destination, retention, isolated restore drill, measured RPO/RTO, and named operator.                                                                         |
| Legal, safety, environmental, tax, insurance, privacy | Official-source DFW/Texas checklists supplied and explicitly marked for review                                                                    | Signed professional and jurisdiction-specific decisions, products/SDS/SOPs, wastewater/backflow/permit plan, terms, retention, consent, insurance, and tax treatment.            |
| Deployment and operations                             | Static production image, health boundary, runbooks, incidents, and observability contracts available                                              | Reviewed hosting, TLS, secret manager, access restrictions, alerts, on-call, rollback, capacity/rate/spend limits, and production canaries.                                      |
| Distribution license                                  | Upstream MIT/notices and third-party inventory preserved                                                                                          | Select and record the root StoryOps AI distribution license before distribution.                                                                                                 |

## Bounded first-pilot conditions

A real pilot remains prohibited until every row in the launch record in
[`docs/runbooks/PILOT_OPERATOR_RUNBOOK.md`](docs/runbooks/PILOT_OPERATOR_RUNBOOK.md)
has a named owner, date, and reviewable evidence. When authorized, the first
pilot should remain limited to:

- one company and a small named crew;
- explicitly mapped DFW ZIP codes and reviewed jurisdictions;
- individually approved exterior services, products, equipment, price-book
  revision, terms, and SOPs;
- one provider activated and canaried at a time;
- owner review of every estimate and customer commitment during the pilot;
- a daily provider/offline/incident reconciliation and named manual fallback;
- immediate stop on uncertain safety, legal, environmental, consent, payment,
  scope, availability, or provider state.

## Known product limits

- V1.1 includes one repository-controlled exterior-services pack. It is not a
  runtime marketplace and does not claim arbitrary vertical support.
- The exterior scope checklist intentionally captures a conservative,
  property-wide evidence set. Pack-specific view selection belongs to the next
  industry-pack lifecycle rather than a hidden V1.1 exception.
- Manual authenticated AI Office runs exist, but no cron/queue scheduler is
  activated or represented as running.
- Final source-freeze verification and byte-current V1.1 screenshots are
  pending. Until recorded, this report authorizes neither a real pilot nor a
  provider canary.
- QuickBooks support is a checksummed, formula-safe export boundary, not a live
  accounting sync or general ledger.
- No payroll, inventory ERP, franchise/multi-company SaaS billing, licensed-
  trade diagnosis, or autonomous legal/safety/bank/vendor action is included.
- Local synthetic and provider-contract tests do not prove a hosted deployment,
  external delivery, funds movement, legal compliance, or safe field work.

## Next product proof

The next engineering milestone should prove the reusable kernel with recurring
residential cleaning. That vertical exercises room/count/hour pricing,
photo-optional manual evidence, first-clean versus maintenance duration,
recurrence mutation, cleaner continuity, and non-blocking weather. The ready-
to-run objective is [`NEXT_GOAL_PROMPT.md`](NEXT_GOAL_PROMPT.md).

The authoritative final command results, migration count, screenshots, backup
proof, and commit provenance will be recorded in
[`BUILD_REPORT.md`](BUILD_REPORT.md) after final source freeze. Operational
authority remains
[`docs/SOURCE_OF_TRUTH.md`](docs/SOURCE_OF_TRUTH.md), and the current gate
status remains [`docs/STATUS.md`](docs/STATUS.md). No push or deployment is
authorized by this readiness assessment.
