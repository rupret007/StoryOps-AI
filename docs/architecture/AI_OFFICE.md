# StoryOps AI Office

**Status:** V1 production boundary  
**Owner:** Company owner (business policy), principal engineer (technical policy)  
**Last reviewed:** 2026-07-29  
**Source of truth:** Code under `src/core/ai`, persisted approvals/traces in Supabase, and this document

The AI office is a controlled proposal-and-execution system. A model may produce advisory prose
and propose an action. Model prose is never source-of-truth and cannot call a provider directly.
Deterministic application policy, a typed least-privilege registry, idempotency, and—when
required—an exact-payload approval stand between a proposal and every side effect.

This follows StoryLand’s central operating rule in a form suitable for software:

> AI gathers, drafts, checks, and proposes. Trusted code calculates and verifies. The owner
> approves sensitive commitments and acts personally where delegation is unsafe.

## Runtime flow

1. An authenticated owner or dispatcher manually selects a specialist. Specialists require exactly
   one allowed root-record type and UUID; the owner briefing accepts no root selector. The browser
   creates a stable run UUID/request time/idempotency key, uses the fixed objective for that
   specialist, and sends optional notes only as bounded untrusted chat data. The legacy
   `trustedFacts` field carries at most the root identity selector; it never carries a caller-owned
   fact value.
2. The Edge boundary strictly validates the finite request, authenticates the token, and verifies
   that actor ID and role match an active owner/dispatcher membership. It atomically claims
   idempotency and calls `begin_storyops_ai_office_run`, which rejects paused companies and
   persists a manual `automation_runs` record without storing the manual note.
3. Server-only, least-privilege RPCs resolve the selected company-owned root and bounded related
   records. Owner briefings load a bounded company aggregate. The selector chooses what to read; it
   is never treated as evidence itself.
4. A purpose- and provider-scoped data-minimization policy removes direct
   contact identifiers, payment-card/SSN patterns, credentials, and
   secret-shaped text before the model boundary. Exact contact data remains
   behind authenticated record/tool boundaries.
5. The guardrail envelope labels all customer text, email, SMS, transcripts, OCR, reviews, and
   retrieved prose as `DATA_ONLY_NEVER_INSTRUCTIONS`.
6. Injection detectors flag instruction override, role impersonation, secret extraction, tool
   coercion, and delimiter attacks.
7. The selected specialist receives only its instructions and capability surface.
8. The model must return `OfficeAgentOutput`; Zod rejects extra fields, malformed actions, missing
   confidence, and invalid risk values.
9. Evidence and every proposed action must cite IDs from the server-resolved trusted-fact set.
   Citation existence is not semantic grounding. A deterministic narrative validator also checks
   protected measurement, price, availability, payment, delivery, legal/regulatory, and chemical
   claim classes. It rejects unrelated citations, values absent from the matching cited fact, all
   model legal/regulatory conclusions, and all model chemical instructions. Summary and
   `customerDraft` have no citation channel, so protected factual assertions in either fail closed.
10. The orchestrator rejects duplicate action IDs and capabilities outside the specialist
    allowlist.
11. Deterministic policy denies injection-influenced or ungrounded actions.
12. Read-only or explicitly approved low-risk, reversible, idempotent tools may execute.
13. Sensitive proposals become persisted approval requests containing the exact canonical payload
    hash. They do not execute.
14. An approved action needs a dedicated server executor. V1’s owner-only `ai-approved-action`
    boundary supports exact-approved `records.create_lead`, `records.update_lead`, and
    `payments.refund`. It reloads the approval, verifies
    company/run/action/tool/expiry/payload hash and current domain eligibility, and obtains an
    atomic execution lease. Successful completion consumes the approval exactly once; ambiguous
    provider state remains reconcilable.
15. The Edge function calls `complete_storyops_ai_office_run` or
    `fail_storyops_ai_office_run`. Completion persists the strict result, model mode, disposition,
    approval link, and—only for a briefing—an `owner_briefings` row.
16. The browser accepts the response only when strict Zod and company/actor/run/agent identity
    checks pass, then calls actor-bound `get_storyops_ai_office_recent` and requires the durable
    readback to match. Every newly persisted result includes
    `storyops-ai-narrative-policy-v1`: summary is non-authoritative advisory, evidence prose is
    non-authoritative rationale, unknowns are non-authoritative AI-reported unknowns,
    `customerDraft` is an unsent non-authoritative draft, and `automaticSendAllowed` is the literal
    `false`. A compatibility parser applies that same conservative classification when reading a
    pre-policy durable result.
17. The live page labels AI prose and rationale as non-authoritative, labels referenced IDs as
    pointers to server records rather than evidence, labels drafts as unsent/human-review-required,
    and separates deterministic action dispositions.
18. Redacted trace events record guardrails, model boundaries, policy decisions, approvals, and
    tool results.

AI Office has no scheduler in V1. A run exists only after an owner or dispatcher presses a manual
run control or invokes the same authenticated manual command. The UI and read model explicitly
report `schedulerConfigured: false`.

OpenAI’s Agents SDK describes an agent as a focused unit containing instructions, tools,
guardrails, handoffs, and structured output. It also distinguishes local application context from
model-visible conversation context. StoryOps uses that separation and keeps authenticated runtime
state outside model input unless it was loaded from an authoritative record. See the official
[agent definitions guide](https://developers.openai.com/api/docs/guides/agents/define-agents).

Both server adapters submit one strict structured-output schema. Every field is required,
`additionalProperties` is false, and the absence of customer-facing copy is represented by the
required nullable `customerDraft` field rather than an optional field. This follows OpenAI's
[strict-mode contract](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)
and is enforced by a runtime schema-conversion unit test, preventing the SDK from silently falling
back to best-effort output. Because strict schemas cannot expose an arbitrary-key object, a proposed
tool payload crosses the model boundary as bounded `payloadJson`; the server rejects malformed,
non-object, or reserved-key JSON, decodes it, and then applies the exact per-tool Zod schema and
policy checks before any execution.

## Specialist roster

| Specialist     | Responsibility                                       | Notable capabilities                                           | Never assumes                                        |
| -------------- | ---------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| Intake         | Qualify inbound leads and identify missing facts     | Lead read/write, geocode, bounded upload, draft communications | Property facts, measurements, budget                 |
| Estimating     | Gather evidence and request deterministic pricing    | Records, photos, `pricing.calculate`, quote drafts             | Measurements, price, scope certainty                 |
| Scheduling     | Find capacity-, weather-, and route-aware options    | Calendar, NWS, VROOM, maps                                     | Availability, forecast, drive time                   |
| Follow-up      | Prepare lifecycle and maintenance follow-up          | Records and consent-checked communications                     | Consent or customer intent                           |
| Marketing      | Prepare campaigns and review drafts                  | Audiences and communication drafts                             | Consent, testimonials, review facts                  |
| Finance        | Read provider state and prepare billing actions      | Payment status, checkout, invoice, export, refund proposal     | Payment success, settled funds                       |
| Safety         | Triage supplied safety/incident facts                | Records, assets, forecast, owner-reviewed drafts               | Chemical, medical, legal, or regulatory instructions |
| Owner briefing | Summarize today, approvals, cash, pipeline, and risk | Read-only metrics, calendar, payment, weather                  | Missing or stale source state                        |

The capability matrix is defined once in `src/core/ai/agents.ts`. The orchestrator checks it again
even if a model emits a syntactically valid tool name.

## Structured output contract

Every specialist model returns:

- a bounded advisory summary;
- overall confidence from 0 to 1;
- non-authoritative rationale entries, each with one or more trusted fact IDs and its own
  confidence;
- explicit unknowns;
- zero or more action proposals;
- an optional unsent customer-facing draft; and
- an owner-attention flag.

The orchestrator—not the model—adds the fixed narrative-policy object before serialization and
persistence. `customerDraft` is data, not a send command; no specialist has an outbound customer
send capability. Customer contact remains in the consent-aware deterministic outbox workflow.
It also prepends an explicit non-authoritative/unsent marker to each persisted summary, rationale,
reported unknown, and draft so a downstream projection such as an owner-briefing section cannot
shed the classification by omitting adjacent metadata. Valid source IDs alone never make model
prose authoritative.

The semantic checker is deliberately finite and fail-closed for the protected high-impact claim
classes above. It binds quantities only to whitelisted measurement/price fields, status words only
to whitelisted status fields, and availability only to bounded status/window fields; IDs,
timestamps, versions, confidence values, and other coincidental numbers do not satisfy a claim.
Payment claims additionally require a database, provider, or deterministic-calculation source.
Unparsed number words and relative dates fail closed. Natural-language detection cannot prove
arbitrary prose true. Prose outside that finite vocabulary therefore remains explicitly advisory
and must be verified in the referenced source record; it cannot become an action disposition,
price, payment/delivery receipt, or provider send.

Every action proposal contains a stable action ID, typed tool name, purpose, JSON-only payload,
risk, reversibility declaration, and source fact IDs. Tool input schemas validate the payload again
at execution time. Tool metadata—not model metadata—is authoritative when the two disagree.

Photo/OCR content is always untrusted. A photo-derived scope must preserve visible evidence,
confidence, and unknowns. It cannot silently become a measurement or price.

The live `pricing.calculate` tool accepts only a stored estimate ID. Server code reloads the
company-owned active price book and rules, stored calculation input, estimate-line evidence IDs,
human-verified measurements, customer tax status, and current photo disposition. It recomputes
with the Decimal engine and rejects the call if the stored total has drifted. The model cannot
supply quantity, attributes, price-book rules, tax status, discount amount, or total to that tool.

## Prompt-injection defense

StoryOps assumes every external text field can be hostile. Defense is layered:

- external content is structurally separated and explicitly marked as inert data;
- common injection signals are detected before model execution;
- the model envelope omits actor IDs and redacts email, phone, SSN,
  payment-card, credential, and secret-shaped text from objectives, trusted
  facts, and untrusted content;
- every model-start trace records the applicable minimization-policy ID and
  redaction count without recording the removed values;
- secrets and authorization-shaped fields are redacted from trace attributes;
- the model has no provider credentials or direct provider tools;
- every action must cite trusted facts;
- any injection signal denies action execution, including after human approval;
- capability allowlists and input schemas apply after model generation; and
- tools run only on the server.

Detection is intentionally conservative. A flagged lead may still be summarized for the owner, but
it cannot cause a side effect. The owner should create a clean manual action from verified facts
rather than approve the injected proposal.

## Policy and approvals

The following always require exact-payload approval:

- price overrides, publishing a price book, or work outside approved pricing/SOPs;
- large discounts and margin exceptions (enforced by the domain pricing/policy layer);
- refunds;
- legal or safety messages;
- replies to negative reviews;
- vendor changes;
- bank actions; and
- merges, deletion, or other destructive/irreversible changes.

Unregistered sensitive actions can be queued for owner review as manual actions. Approval does not
magically create a missing provider capability; execution fails closed until a typed implementation
exists.

An approval binds:

- company ID;
- run ID and action ID;
- tool name;
- declared action risk;
- exact JSON payload snapshot;
- SHA-256 of canonical `{runId, actionId, toolName, risk, payload}`;
- policy rule and reason;
- requester;
- creation and expiry; and
- decision actor/time.

Changing one cent, one recipient, one date, or one ID invalidates the approval. Only an
authenticated owner may decide an approval in V1; downstream tool policy narrows execution
further. OpenAI’s official
guidance likewise treats guardrails as automatic checks and human review as the pause before
sensitive side effects; see
[Guardrails and human review](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals).

## Idempotency and retry

AI runs use `company + scope + idempotency key` and a canonical request hash. A repeated matching
request returns the stored result. Reusing a key with a different payload is a conflict. Concurrent
in-memory calls coalesce; Supabase Edge uses atomic `claim_idempotency_key` /
`complete_idempotency_key` RPCs for cross-instance persistence.

The durable run uses the same UUID and key. A failed exact retry may return the run to `running`
with an incremented attempt, while a completed durable run repairs an uncertain idempotency
response without rerunning the model. The client retains the same UUID and request time while a
manual retry is unresolved.

Before a live model run, the Edge boundary consumes durable per-user hourly and per-company daily
run windows plus a daily company token reservation. Integration health and outbound communications
use the same durable budget primitive with their own scopes. Exhaustion returns a bounded error;
restarting an Edge instance does not reset a limit.

Tools retry at most three times only when:

- the operation is read-only, or the provider/tool explicitly supports idempotency; and
- the thrown error is typed as transient/retryable.

Irreversible, non-idempotent actions get one attempt. Backoff is exponential with bounded jitter.
Provider event IDs are independently deduplicated.

## Tracing and audit

Trace event types include run start/completion/replay, injection flags, model start/completion/
rejection, policy decisions, approval creation, and tool start/completion/failure. The Edge adapter
persists spans to `ai_traces`; database mutation triggers persist the durable audit trail.

The OpenAI Agents SDK adapter keeps SDK tracing enabled but sets
`traceIncludeSensitiveData: false`. StoryOps traces carry redacted attributes and no credentials.
OpenAI documents that SDK traces cover model calls, tool calls, handoffs, guardrails, and custom
spans in [Integrations and observability](https://developers.openai.com/api/docs/guides/agents/integrations-observability#tracing).

Default AI-trace retention is 90 days in the Edge example. Audit and legal-hold retention come from
company policy and database metadata. Never shorten a legal hold through an automation.

## Server boundaries and modes

- `SandboxStructuredModel` is deterministic, needs no key, proposes no default actions, and
  explicitly reports live AI as unknown.
- `mcp/openai-agents-adapter.ts` is the Node server adapter for `@openai/agents`.
- `supabase/functions/_shared/openai-agents.ts` is the Edge server adapter.
- Live structured OpenAI requires both `OPENAI_MODE=live` and the explicit kill
  switch `OPENAI_LIVE_ENABLED=true`, plus `OPENAI_API_KEY` and `OPENAI_MODEL`.
  A mode, flag, or key alone does nothing.
- Live vision requires `OPENAI_MODE=live`, its separate
  `OPENAI_VISION_LIVE_ENABLED=true` gate, `OPENAI_API_KEY`, and an explicit
  `OPENAI_VISION_MODEL`. Enabling general OpenAI does not authorize photo
  analysis.
- `OPENAI_MODE=disabled` blocks live and deterministic sandbox AI Office/photo
  execution; it does not produce a synthetic result.
- Browser code imports only model/tool contracts. It never imports the Agents SDK or provider
  secrets.
- MCP exposes only health, content inspection, and a no-side-effect sandbox run.

## Failure behavior

The AI office fails closed:

- malformed model output: no action;
- unknown evidence ID: no action;
- capability mismatch: action denied;
- injection signal: action denied;
- missing tool: action denied;
- provider uncertainty: unknown, never success;
- approval mismatch/expiry: no action;
- idempotency conflict: HTTP 409 / typed error;
- tool output schema failure: action failed; and
- missing live credentials: sandbox or disabled, never fake live success.

Use `docs/runbooks/AI_OFFICE_RUNBOOK.md` for operating cadence and
`docs/incidents/AI_INTEGRATION_INCIDENT_PLAYBOOK.md` when a control fails.

## V1 limits

- The deterministic application orchestrator is authoritative; the Agents SDK is used as the
  server-side structured model adapter, not as an autonomous provider-execution loop.
- Approval decisions are durable owner-only commands. Persisted approved execution is intentionally
  limited to exact-approved lead creation/update and Stripe refunds; no generic “execute any
  approval” endpoint exists.
- AI Office is manual-triggered. No recurring, overnight, cron, or provider scheduler is implemented
  or claimed.
- Chemical selection/instruction, legal conclusions, emergency response, regulatory filing, and
  bank/vendor execution remain human work.
- Sandbox geocodes are deliberately low-confidence synthetic coordinates and must never be used for
  dispatch. Sandbox weather deliberately contains no forecast.
- No real credential, external model/provider canary, spend validation, or hosted trace review has
  been performed. Live enablement remains a manual YELLOW gate even though the boundary is
  implemented.

## Change control

Any change to agent capability lists, auto-execution rules, approval categories, trace retention,
or server credential boundaries requires:

1. owner/product approval;
2. a policy/version note;
3. unit tests for allow, approval, deny, injection, and replay;
4. a sandbox golden-path run; and
5. an entry in the build report or incident corrective action.
