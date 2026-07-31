# StoryOps service-industry packs

**Status:** V1.1 extension contract  
**Last reviewed:** 2026-07-29  
**Current pack:** `exterior-services` / `storyops-exterior-dfw-v1.1.0`

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
is `src/data/exteriorServiceTemplates.ts`; it is data and deterministic rules,
not a fork of the CRM or operating workflows.

V1.1's registry is repository-controlled and the exterior pack is the only
pack that can be installed through the product. The company configuration
studio can configure and publish that pack's operating baseline, but it is not
yet a runtime pack marketplace or arbitrary manifest importer. Checklist,
completion, material/SDS, weather, and routing behavior still contains
exterior-pilot defaults. Those facts are explicit product limits, not a claim
that changing a company name makes an unsupported vertical safe.

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

Likely next packs are lawn/landscape maintenance, residential cleaning, pest
control, pool service, and handyman work. HVAC, electrical, plumbing, medical,
legal, financial, and similarly regulated work require materially stronger
licensing, safety, inventory, diagnostic, and compliance contracts before they
can use automatic back-office actions.

The next recommended proof is recurring residential cleaning. It forces the
kernel to support room/count/hour pricing, photo-optional and manual scope,
first-visit versus recurring duration, skip/pause/reschedule semantics,
cleaner-continuity preferences, and non-blocking weather policy without entering
a licensed trade. The executable V1.2 objective is
[`NEXT_GOAL_PROMPT.md`](../../NEXT_GOAL_PROMPT.md).
