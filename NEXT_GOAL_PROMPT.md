# Next overnight goal — WashOps V1.2

Copy the block below into a new Codex task after V1.1 is committed.

```text
/goal Act as principal engineer, product owner, service-business operator,
AI systems engineer, security engineer, and release engineer.

Turn the current WashOps exterior-services pilot into a genuinely reusable
service-business platform by proving a second, materially different vertical:
recurring residential cleaning. Build working software, not merely a plan.

STARTING POINT

Repository: /Users/jeffstory/Documents/WashOps-AI
Starting point: the final local V1.1 commit on
codex/exterior-services-pilot-v1.1
Working branch: codex/service-industry-packs-v1.2

Read README.md, BUILD_REPORT.md, PILOT_READINESS_REPORT.md,
docs/SOURCE_OF_TRUTH.md, docs/STATUS.md,
docs/architecture/INDUSTRY_PACKS.md, all migrations, tests, runbooks, incident
documents, and licensing notices.

Run the full V1.1 verification suite before modifying behavior. Preserve every
pricing, approval, evidence, payment, consent, tenant, provider-truth,
idempotency, offline, audit, and active-membership invariant. Use parallel
subagents for kernel extraction, residential-cleaning domain/pricing,
workflow-policy migration, UI/E2E, and independent release audit.

Do not push, deploy, purchase services, activate providers, contact customers,
or expose secrets. Commit the finished work locally.

PRIMARY OBJECTIVE

Make a versioned industry pack installable, reviewable, publishable, and usable
through the product without source-code changes. Exterior cleaning must remain
fully functional. Residential cleaning must complete the same real
lead-to-recurring golden path while exercising different pricing, evidence,
scheduling, field, and recurrence policies.

This is still a single-company product. Do not add SaaS billing, marketplace
payments, arbitrary tenant self-provisioning, or universal support for regulated
trades.

PACK CONTROL PLANE

Build an atomic industry-pack lifecycle:

- immutable pack manifest with pack ID, semantic version, compatibility range,
  provenance, schema version, checksum, and review state;
- import/install as an unpublished company draft;
- deterministic validation with complete error reporting;
- explicit owner review and publication;
- exact idempotent replay and same-key/different-payload conflict;
- immutable published revisions and auditable rollback to a previously
  published revision;
- upgrade preview that identifies added, changed, retired, and incompatible
  records before publication;
- no partial install: catalog, price templates, aliases, policies, checklists,
  packages, and fixtures publish together or not at all;
- no executable JavaScript or SQL supplied by a pack;
- a constrained, versioned formula/policy DSL interpreted by trusted code;
- tenant isolation and active-company/active-membership checks at every
  boundary.

Expose this lifecycle in Company Configuration Studio. The UI must show which
pack and version control each active artifact, validation results, publication
status, compatibility, and rollback target. Installing or completing setup must
never silently publish prices, terms, providers, communications, or launch
authorization.

KERNEL VERSUS PACK CONTRACT

Remove remaining exterior-specific behavior from the reusable kernel. A pack
must be able to define, within validated enums and bounded schemas:

- service codes, names, categories, customer-facing descriptions, and request
  aliases;
- measurement kinds, units, applicability, evidence source, and human
  verification requirements;
- deterministic Decimal price rules, minimums, duration/cost rules,
  classifications, add-ons, and good/better/best packages;
- photo-required, photo-optional, manual-measurement, imported-measurement, and
  not-applicable scope policies;
- required scope views and structured human-review attestations;
- skills, crew size, equipment classes, transfer/mobilization buffers, and
  capacity rules;
- scheduling rules including whether weather is a hard gate, advisory, or not
  applicable, and whether route optimization is required or advisory;
- checklist templates, completion evidence, signature policy, materials/SDS
  policy, incident prompts, and customer acceptance requirements;
- recurrence cadences, skip/pause/reschedule rules, visit-generation horizon,
  and fresh-estimate requirements;
- pack-specific owner briefing vocabulary, safety escalation, and AI evaluation
  fixtures.

Reject unknown policy values, conflicting code grammars, unsupported pricing
units, missing references, duplicate aliases, unbounded formulas, and pack
attempts to weaken kernel security.

Make request aliases flow through publication into every live intake channel.
Make manual and imported human-verified measurements first-class so a
photo-optional or non-photo pack never depends on an unrelated photo analysis.

RESIDENTIAL CLEANING PACK

Create and seed a production-shaped `residential-cleaning` pack with reviewed
starter drafts for:

1. Standard recurring clean
   - home square footage;
   - bedroom and bathroom counts;
   - occupied/vacant;
   - frequency: weekly, biweekly, every four weeks, or monthly;
   - first-visit versus maintenance duration and price;
   - pets, clutter/access, and owner-reviewed condition classifications.

2. Deep clean
   - square footage plus room/count factors;
   - condition and elapsed-time-since-last-clean classifications;
   - deterministic additional labor;
   - mandatory human review for severe/unknown condition.

3. Move-in/move-out clean
   - vacant-property workflow;
   - appliance/cabinet scope;
   - deterministic duration and crew requirement;
   - exclusions and handoff/inspection evidence.

4. Common add-ons
   - inside oven;
   - inside refrigerator;
   - inside cabinets;
   - interior windows;
   - blinds;
   - baseboards;
   - laundry/linen change;
   - pet-hair or high-detail add-on.

Support flat, each/count, square-foot, and hour/duration inputs using Decimal
only. Define exact minimum, travel, tax, deposit, discount, margin, and approval
rules. AI may collect or flag values but may never invent room counts, home
area, duration, price, condition, availability, payment, product instructions,
or regulations.

The residential pack should normally make pre-estimate photos optional, make
weather non-blocking for indoor work, retain route/capacity awareness, require
cleaner continuity where configured, and use room/area checklists rather than
exterior elevations. These are versioned pack policies, not hard-coded UI
exceptions.

RECURRING-FIRST OPERATIONS

Build recurrence as a real operating loop:

- series plus independently versioned visit occurrences;
- weekly, biweekly, every-four-weeks, monthly, and bounded custom cadence;
- skip, pause, resume, reschedule-one, and change-future-occurrences without
  corrupting completed history;
- first-clean versus recurring-clean price/duration;
- crew continuity preference that does not override capacity or permissions;
- occurrence-level route/capacity evidence;
- customer-requested changes that remain requests until policy-approved;
- no implicit card charge or payment claim;
- fresh-estimate policy when scope, frequency, condition, or price-book version
  requires it.

USER EXPERIENCE

Make setup, lead intake, estimate workbench, quote/portal, dispatch, mobile field
packet, command center, pilot readiness, and owner briefing derive their labels,
fields, evidence requirements, and next actions from the active pack.

Do not render irrelevant exterior fields for residential cleaning. Do not hide
missing pack support behind generic free-text fields.

Add a pack-aware global search and clear badges showing pack/version on
services, estimates, jobs, checklists, and recurring plans.

AI OFFICE

Keep manual owner/dispatcher agent runs and durable readback working. Extend the
specialists and evaluations for residential-cleaning vocabulary and recurrence.
The model may propose, summarize, or draft only from server-resolved facts.
Pack data remains untrusted configuration until validated and published.

Add adversarial evaluations for:

- inventing rooms, square footage, condition, duration, or prices;
- applying exterior photo/weather rules to an indoor cleaning job;
- skipping recurrence conflicts or cleaner availability;
- treating a skipped occurrence as cancellation of the series;
- inventing payment/autopay state;
- unsafe product or mixture advice;
- prompt injection through customer notes, pack descriptions, imports, or
  photos;
- using an unpublished, incompatible, or cross-company pack revision.

MIGRATION AND COMPATIBILITY

Migrate the existing exterior pack into the same runtime lifecycle without
changing its published math or weakening its scope-evidence bundle. Existing
V1.1 records must retain exact pack/version provenance.

Prove:

- fresh install of each pack;
- idempotent replay and conflicting import;
- rejected malformed/incompatible pack;
- draft edit without publication;
- exact publication and rollback;
- upgrade preview and successful compatible upgrade;
- exterior and residential companies isolated in the same database;
- no mixed-pack catalog, measurement, checklist, or price references;
- old estimates/jobs remain reproducible after pack upgrades.

VERIFICATION

Run and fix:

npm ci
npm audit --audit-level=high
npm run format:check
npm run licenses:check
npm run lint
npm run typecheck
npm run check:edge
npm test
npm run test:infra
npm run build
npm run test:e2e
npm run test:supabase -- --reset

Also prove with automated tests:

- complete exterior-cleaning regression;
- complete residential-cleaning lead-to-recurring flow;
- every starter formula and package with exact line-item math;
- all pack lifecycle replay/conflict/rollback cases;
- tenant, role, customer-portal, and active-membership isolation;
- manual/imported measurement authorization;
- pack-specific photo, weather, route, material, checklist, and completion
  behavior;
- recurrence skip/pause/resume/reschedule behavior;
- offline restart and reconciliation for both field packets;
- AI no-invention, injection, and unpublished-pack evaluations;
- Docker production image, VROOM route, backup/restore dry-run, secret scan, and
  placeholder scan.

Do not weaken tests or add fake success.

MORNING HANDOFF

Create SERVICE_INDUSTRY_PACK_REPORT.md and update README.md, BUILD_REPORT.md,
PILOT_READINESS_REPORT.md, docs/SOURCE_OF_TRUTH.md, docs/STATUS.md,
docs/briefings/CURRENT.md, and docs/architecture/INDUSTRY_PACKS.md.

Report:

- the exact stable kernel/pack boundary;
- pack manifest and lifecycle;
- exterior and residential capabilities;
- formula and policy examples;
- complete workflows and screenshots;
- migration/compatibility behavior;
- tests with exact results;
- provider/manual/legal gates;
- known limits and next priorities;
- branch and commit provenance.

Finish with an independent release-gate review. Resolve every locally
actionable P0/P1. Commit on codex/service-industry-packs-v1.2 and leave the
working tree clean. Do not push or deploy.

DELIBERATE NON-GOALS

- no universal “any business” claim;
- no HVAC, electrical, plumbing, pest-control, medical, legal, financial, or
  other regulated pack;
- no arbitrary customer-authored code;
- no payroll, full accounting ledger, inventory ERP, marketplace, franchise,
  multi-company SaaS billing, or autonomous live-provider activation;
- no claim that local tests replace provider canaries, legal review, safety
  review, insurance, tax review, or a real operator pilot.
```
