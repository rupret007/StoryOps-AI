# Approval Record

- Approval ID:
- Company:
- Run / trace ID:
- Requested at:
- Expires at:
- Requested by:
- Policy version / rule:
- Risk:
- Reason:

## Exact action

- Tool / action type:
- Entity:
- Recipient / provider target:
- Amount (if any):
- Date/time (if any):
- Payload SHA-256:

```json
PASTE THE REDACTED EXACT PAYLOAD SNAPSHOT FROM WASHOPS
```

## Source check

- Server-resolved trusted fact IDs:
- Price-book version:
- SOP version:
- Consent snapshot:
- Availability/weather/payment observation time:
- Unknowns:

## Decision

- [ ] Approved exactly as shown
- [ ] Rejected
- Decision actor:
- Decision time:
- Note:

Any changed field requires a new approval. Never hand-edit an approved payload.
Approval does not itself execute an external action.

## Execution and reconciliation

- Registered server executor:
- Execution lease / idempotency reference:
- Provider and mode:
- Provider receipt ID / status:
- Consumed at:
- Replayed: yes / no
- Reconciliation worksheet / incident:

V1 external resume supports only exact-approved Stripe refunds. Leave this
section “manual / no executor” for every other sensitive action.
