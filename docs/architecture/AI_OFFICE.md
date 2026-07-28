# StoryOps AI Office

**Status:** V1 production boundary  
**Owner:** Company owner (business policy), principal engineer (technical policy)  
**Last reviewed:** 2026-07-28  
**Source of truth:** Code under `src/core/ai`, persisted approvals/traces in Supabase, and this document

The AI office is a controlled proposal-and-execution system. A model may summarize evidence and
propose an action. It cannot call a provider directly. Deterministic application policy, a typed
least-privilege registry, idempotency, and—when required—an exact-payload approval stand between a
proposal and every side effect.

This follows StoryLand’s central operating rule in a form suitable for software:

> AI gathers, drafts, checks, and proposes. Trusted code calculates and verifies. The owner
> approves sensitive commitments and acts personally where delegation is unsafe.

## Runtime flow

1. An authenticated trigger creates an `OfficeRunRequest` with a company, actor, specialist,
   objective, client context, untrusted content, and idempotency key.
   The user-facing Edge boundary independently verifies that the actor ID and role match an active
   owner/dispatcher membership; callers cannot self-assert an elevated role. It ignores the
   request’s entire client-supplied `trustedFacts` value and reloads the role/company fact set from
   Supabase.
2. The guardrail envelope labels all customer text, email, SMS, transcripts, OCR, reviews, and
   retrieved prose as `DATA_ONLY_NEVER_INSTRUCTIONS`.
3. Injection detectors flag instruction override, role impersonation, secret extraction, tool
   coercion, and delimiter attacks.
4. The selected specialist receives only its instructions and capability surface.
5. The model must return `OfficeAgentOutput`; Zod rejects extra fields, malformed actions, missing
   confidence, and invalid risk values.
6. Evidence and every proposed action must cite IDs from the server-resolved trusted-fact set.
7. The orchestrator rejects duplicate action IDs and capabilities outside the specialist allowlist.
8. Deterministic policy denies injection-influenced or ungrounded actions.
9. Read-only or explicitly approved low-risk, reversible, idempotent tools may execute.
10. Sensitive proposals become persisted approval requests containing the exact canonical payload
    hash. They do not execute.
11. An approved external action needs a dedicated server executor. V1’s owner-only
    `ai-approved-action` executor supports exactly `payments.refund`: it reloads the approval,
    verifies company/run/action/tool/expiry/payload hash and current payment eligibility, obtains an
    atomic execution lease, and executes with a server-derived provider idempotency key. Successful
    completion consumes the approval exactly once; ambiguous state remains reconcilable.
12. Redacted trace events record guardrails, model boundaries, policy decisions, approvals, and
    tool results.

OpenAI’s Agents SDK describes an agent as a focused unit containing instructions, tools,
guardrails, handoffs, and structured output. It also distinguishes local application context from
model-visible conversation context. StoryOps uses that separation and keeps authenticated runtime
state outside model input unless it was loaded from an authoritative record. See the official
[agent definitions guide](https://developers.openai.com/api/docs/guides/agents/define-agents).

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

Every specialist returns:

- a bounded summary;
- overall confidence from 0 to 1;
- evidence claims, each with one or more trusted fact IDs and its own confidence;
- explicit unknowns;
- zero or more action proposals;
- an optional customer-facing draft; and
- an owner-attention flag.

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
- Approval decisions are durable owner-only commands. Persisted external resume is intentionally
  limited to authenticated, exact-approved Stripe refunds; no generic “execute any approval”
  endpoint exists.
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
