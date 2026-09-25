# WashOps and Integration Incident Playbook

**Purpose:** Contain unsafe automation or provider inconsistency without losing evidence.  
**Incident commander:** Company owner until explicitly handed off  
**Last updated:** 2026-07-28

Print or cache this document. Do not depend on the affected AI/provider to tell you how to recover.
For an injury, exposure, spill/runoff, suspected backflow, fall, heat/weather,
equipment, vehicle, or property event, use the
[field safety and environmental incident playbook](./FIELD_SAFETY_ENVIRONMENTAL_INCIDENT_PLAYBOOK.md)
first; this playbook then governs any related AI/provider failure.

## Universal first five minutes

1. **Protect people and property.** If there is an immediate physical emergency, stop work and use
   the appropriate local emergency response. The AI does not handle emergencies.
2. **Stop the affected automation.** Disable the one live provider/capability or set
   `OPENAI_LIVE_ENABLED=false`. Do not delete queues.
3. **Preserve evidence.** Record time, company, run/trace/event IDs, provider IDs, screenshots with
   secrets/PII redacted, and the last known good action.
4. **Do not retry blindly.** Read provider state and idempotency records first.
5. **Set a human owner.** One person decides; one timeline is authoritative.

## Severity

| Severity | Examples                                                                                                                       | Response                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| SEV-1    | Safety-critical message/action, bank/vendor action, broad secret exposure, cross-company data, uncontrolled destructive writes | Stop affected automation immediately; owner + technical/security/legal review |
| SEV-2    | Wrong price/refund, duplicate charge/message/booking, consent violation, payment state corruption, webhook bypass              | Contain within 15 minutes; owner leads reconciliation                         |
| SEV-3    | Failed integration, stale weather/route, invalid model output safely blocked, delayed briefing                                 | Manual fallback; repair during business day                                   |
| SEV-4    | Sandbox/test-only defect with no customer/provider effect                                                                      | Track and fix in normal workflow                                              |

## 1. Unsafe or ungrounded AI output

- Stop the affected specialist from auto-executing.
- Save the run ID, model, prompt version, output, cited fact IDs, and guardrail result.
- Determine whether the bad output was blocked, approved, or executed.
- If executed, reconcile each provider/entity action separately.
- Reject pending approvals derived from the same bad/stale facts.
- Add a regression test before re-enabling.

Do not “correct” the historical trace. Correct the source record and start a new run.

## 2. Prompt-injection attempt

- Confirm the action was denied by `AI-002-prompt-injection`.
- Preserve the original untrusted content with normal retention/access controls.
- Do not copy its instructions into an owner-approved action.
- If a side effect occurred, treat as SEV-1/2 capability-control failure.
- Rotate any credential if the output or trace exposed it.
- Add the pattern to tests only if it improves detection without teaching the model a bypass.

## 3. Approval bypass or payload mismatch

- Disable approved-action execution.
- Capture approval ID, payload hash, action ID, run ID, decision actor, and provider result.
- Compare persisted approval payload to executed provider payload byte-for-byte/canonical field.
- Revoke/expire sibling approvals from the affected run.
- Review RBAC and database audit events.
- Do not re-enable until a test proves changed recipient/amount/date is rejected.

## 4. Duplicate external action

Examples: two SMS messages, invoices, refunds, or calendar bookings.

- Stop retries for that provider/action.
- Read idempotency key, request hash, provider IDs, and webhook event IDs.
- Determine which external records are authoritative.
- Correct manually only with owner approval; refunds/cancellations may create a second commitment.
- Mark the local discrepancy; never delete one provider record to hide the duplicate.
- Test concurrent identical requests and ambiguous timeout recovery.

## 5. Wrong payment or refund state

- Pause automated billing/refunds.
- Read Stripe/provider state directly.
- Do not infer success from browser redirects, email, or customer statements.
- Preserve event IDs and payload hashes.
- Owner decides any corrective refund/charge; legal/accounting review as appropriate.
- Reconcile invoice, payment, ledger/export, and customer communication.

## 6. Consent or opt-out failure

- Stop outbound messaging to the affected contact/list.
- Persist the earliest known opt-out time and provider signal.
- Identify every message sent after withdrawal.
- Do not send an apology by the same blocked channel without legal/policy review.
- Review consent proof, snapshot ID, campaign selection, webhook delay, and provider block state.
- **Legal review required** for notification, remediation, and reporting.

## 7. Invalid webhook signature accepted

- Disable the endpoint/provider immediately.
- Treat every affected event as untrusted.
- Identify the deployment and time window.
- Compare canonical URL/raw-body handling and secret version.
- Rotate the webhook secret/auth token.
- Reconcile every claimed event to provider logs.
- Add known-valid, invalid, stale, proxy-URL, duplicate, and payload-conflict tests.

## 8. Provider outage or ambiguous timeout

- Disable automatic retry if provider state cannot be read.
- Keep the original idempotency key.
- Check provider status and console/logs.
- Use manual fallback, recording exact provider IDs.
- On recovery, reconcile before replay.
- Re-enable gradually and watch callbacks/rate limits.

## 9. Secret exposure

- Disable/revoke the credential first.
- Preserve evidence without copying the secret again.
- Search code, logs, traces, CI artifacts, screenshots, and support tickets for scope.
- Rotate dependent webhook/signing credentials as needed.
- Review provider activity from the earliest possible exposure.
- **Security/legal review required** for breach analysis and notification.

## 10. Cross-company or privacy exposure

- Disable the affected endpoint/query.
- Preserve user, company, request, trace, and audit IDs.
- Do not ask the AI to summarize exposed content.
- Determine fields, subjects, recipients, and duration.
- Restrict access and place legal holds as directed.
- **Legal review required** before customer/regulator messaging.

## 11. Weather/routing failure

- Stop auto-dispatch for affected visits.
- Owner/dispatcher verifies current official weather, alerts, route, access, and crew capacity.
- Do not turn a missing forecast into “safe.”
- Notify customers only after the owner chooses cancellation/reschedule wording.
- Record source observation times and the manual dispatch decision.

## Recovery gate

- [ ] Affected automation/provider is contained.
- [ ] External state is reconciled by stable IDs.
- [ ] Pending unsafe approvals are rejected/expired.
- [ ] Customer, money, safety, consent, and privacy impact are known.
- [ ] Root cause and contributing controls are documented.
- [ ] A regression test fails before the fix and passes after.
- [ ] Sandbox golden path passes.
- [ ] Live health and one safe test transaction pass.
- [ ] Owner approves re-enable.
- [ ] Incident report and corrective actions have owners/dates.

## AI during an incident

AI may organize supplied facts, correlate IDs, and draft an internal timeline. It may not contact
customers, providers, banks, vendors, emergency services, insurers, attorneys, or regulators; make
legal/safety conclusions; release money; delete evidence; or declare the incident resolved.

Use `docs/templates/INCIDENT_REPORT.md`.
