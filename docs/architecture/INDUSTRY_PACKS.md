# StoryOps service-industry packs

**Status:** V1.1 exterior contract plus draft residential-foundation candidate  
**Last reviewed:** 2026-08-24  
**Registered packs:** `exterior-services` / `storyops-exterior-dfw-v1.1.0` and
`residential-cleaning` / `storyops-residential-cleaning-v1.0.0`

StoryOps is a service-business operating kernel with versioned industry packs.
The first pack is deliberately complete for pressure washing, soft washing,
gutter/downspout cleaning, roof washing, and window cleaning. The core is not
named or coupled to an exterior-cleaning company.

## Stable kernel versus industry pack

| Stable StoryOps kernel                                          | Versioned industry pack                                                      |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Auth, company membership, RBAC, RLS, audit                      | Service codes, names, categories, and aliases                                |
| Leads, customers, properties, communications, consent           | Required scope inputs and measurement units                                  |
| Versioned Decimal price books, approvals, quotes, terms         | Starter formulas, multipliers, minimums, add-ons, and packages               |
| Capacity, route/weather evidence, visits, offline field packets | Skills, equipment types, checklist/SOP references, and field guidance        |
| Invoices, payment truth, portal, reviews, referrals, recurrence | Required photo views, uncertainty triggers, exclusions, and risk escalations |
| AI orchestration, least-privilege tools, traces, incidents      | Specialist vocabulary and pack-specific evaluation fixtures                  |
| Provider interfaces, health, idempotency, reconciliation        | Pack-specific launch and professional-review checklist                       |

The runtime contract is `ServiceIndustryPack` in
`src/domain/industryPack.ts`. A registered pack must have one unique template
per service code; each template must bind the same catalog code, deterministic
price rule, measurement unit, photo guidance, and human-review triggers.
`validateServiceIndustryPack` fails closed on incomplete or inconsistent packs.

The current registry is `src/data/industryPacks.ts`. The exterior implementation
is `src/data/exteriorServiceTemplates.ts`; the draft residential implementation
is `src/data/residentialServiceTemplates.ts`. Both are source-controlled data
and deterministic rules, not forks of the CRM or operating workflows.

The company configuration studio can create a review draft from either
registered pack and resolves pricing, packages, skills, equipment, sandbox
preparation, and readiness through the same fail-closed runtime. A mixed service
selection or pack/version mismatch does not resolve. Configuration publication
still does not activate providers, authorize launch, or prove that the selected
vertical is operationally ready.

When both an active-pack reference and a price-book template version exist,
they must identify the same registered pack version. Conflicting persisted
evidence fails closed; the runtime does not choose one field as more truthful
and does not construct pricing or readiness from the mismatch.

The registry is not a runtime pack marketplace or arbitrary manifest importer.
It has no durable import/install/upgrade/rollback lifecycle, and checklist,
completion, material/SDS, weather, routing, intake, and field behavior still
contains exterior-pilot defaults. Those facts are explicit product limits, not
a claim that selecting a different pack makes an unsupported vertical safe.

## Draft residential foundation boundary

The residential candidate currently provides:

- three typed service templates: standard recurring, deep, and move-in/move-out
  cleaning;
- deterministic square-foot, room/count, condition, frequency, occupancy,
  access, first-service, add-on, cost, duration, tax, deposit, and package math;
- photo-optional scope metadata with explicit human-review triggers;
- Company Configuration Studio selection with exact pack/version binding and
  pack-derived resource readiness; and
- weekly, biweekly, every-four-weeks, monthly, quarterly, semiannual, annual,
  and bounded custom cadence contracts for the existing fresh-estimate due-work
  boundary.

This is a foundation candidate, not a completed residential-cleaning product or
V1.2 release. It does not yet provide the full residential lead-to-recurring
golden path, pack-specific field/checklist and scheduling policy throughout the
product, occurrence lifecycle operations such as skip/pause/resume/reschedule,
or a reviewed pack manifest lifecycle. Starter formulas, package composition,
SOP references, tax, terms, safety, insurance, and operating assumptions require
named human review. Hosted CI, deployment, and live migration evidence are not
claimed by this document.

## Adding another service vertical

A production pack must provide:

1. service catalog records and request aliases;
2. explicit measurement kinds and supported pricing units;
3. complete Decimal rules for every allowed classification;
4. minimum, exact reviewed service-area mapping, travel fee, tax, deposit,
   margin, discount, and approval behavior;
5. add-ons and good/better/best package definitions;
6. required skills, equipment, evidence, checklist, and reviewed SOP references;
7. photo guidance plus uncertainty/risk escalation;
8. setup defaults that remain unpublished drafts;
9. representative price fixtures and adversarial no-invention tests; and
10. an official-source launch checklist with named human reviews.

The pack may narrow the kernel. It may not weaken tenant isolation, provider
truth, idempotency, approval, evidence, offline reconciliation, retention, or
audit rules.

Travel-zone evidence belongs to company configuration, not to an LLM or an
industry-pack guess. V1.1 supports explicit normalized five-digit ZIP mappings.
Each ZIP may map to one zone only, and live publication requires reviewer,
timestamp, and evidence-reference fields. Optional mileage labels are not
authoritative distance evidence and never drive selection. A future pack may
add provider-confirmed distance evidence only as a separately versioned,
tested contract; absence or uncertainty must remain fail-closed.

## Product boundary

V1.1 is reusable for owner-operated, appointment-based field-service companies.
It is not a universal ERP and does not claim that an arbitrary industry can be
enabled by changing a label. A new vertical is ready only when its measurements,
pricing, safety, equipment, workflows, and professional review gates are
implemented and tested as rigorously as the exterior-services pack.

Likely later packs are lawn/landscape maintenance, pest control, pool service,
and handyman work. HVAC, electrical, plumbing, medical, legal, financial, and
similarly regulated work require materially stronger licensing, safety,
inventory, diagnostic, and compliance contracts before they can use automatic
back-office actions.

The next proof is to carry the residential foundation through the complete
recurring-cleaning contract: reviewed room/count/hour pricing, manual scope,
first-visit versus recurring duration, skip/pause/reschedule semantics,
cleaner-continuity preferences, non-blocking weather policy, pack lifecycle,
and a full isolated golden path. The executable V1.2 objective remains
[`NEXT_GOAL_PROMPT.md`](../../NEXT_GOAL_PROMPT.md); the current candidate closes
only a bounded subset of it.
