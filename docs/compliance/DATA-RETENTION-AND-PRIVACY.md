# Data retention, privacy, and evidence handling

> **REQUIRED PRIVACY, RECORDS, TAX, EMPLOYMENT, AND LITIGATION LEGAL REVIEW:**
> The periods below are proposed operating defaults, not statements of law.
> Counsel and the tax professional must approve them for the entity, contracts,
> insurance, workforce, jurisdictions, and data actually processed. A litigation,
> claim, audit, chargeback, incident, regulator, or preservation hold overrides
> scheduled deletion. Revalidate this policy at least annually and whenever a
> service, provider, or jurisdiction changes.

## Principles

- Collect only data needed for a disclosed operational purpose.
- Keep original evidence immutable; corrections are appended with actor, time,
  reason, and before/after references.
- Separate identity/contact data, service evidence, payments, communications,
  agent traces, and audit records so access and retention can differ.
- Do not place SSNs, full payment-card/bank data, passwords, API/OAuth tokens,
  chemical formulas, or unneeded health information in WashOps.
- A customer-facing deletion does not erase audit evidence without an approved
  retention decision; minimize/deidentify retained evidence where permitted.
- Backup retention is not an exception to privacy. Deleted primary data expires
  from backups through the approved backup lifecycle and is not selectively
  edited inside an immutable backup.

## Proposed V1 retention classes

Every row is **PROPOSED — REQUIRED LEGAL/TAX/PRIVACY REVIEW** before production.
Durations are measured from the listed trigger and can be shortened or extended
only by a versioned policy approval.

| Class                                                                     |                                                           Proposed default | Trigger                                        | Notes                                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------: | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Unqualified/abandoned leads                                               |                                                                  12 months | Last inbound/outbound activity                 | Delete contact, property candidates, and uploads unless converted or held                   |
| Declined/expired quotes                                                   |                                                                  24 months | Quote expiry/decline                           | Preserve price-book/rule version and minimal decision audit                                 |
| Customers, properties, contracts, jobs, invoices, payments                |                                                                    7 years | Final payment/close of last related obligation | Keep provider IDs/status, never full card or bank data                                      |
| Job checklists, signatures, before/after photos, incident-linked evidence |                                                                    4 years | Job close                                      | Incident/claim/contract/insurance hold may supersede                                        |
| Routine transactional communication body                                  |                                                                  24 months | Sent/received                                  | Retain delivery/consent audit longer if approved; redact secrets                            |
| Marketing consent and suppression                                         | 7 years after last covered send; suppression while needed to honor opt-out | Consent/revocation/last send                   | Store channel, purpose, disclosure version/source, timestamp, evidence                      |
| Review/referral request record                                            |                                                                  24 months | Request/result                                 | Preserve neutral eligibility; no sentiment-gating profile                                   |
| AI prompts/responses/tool arguments                                       |                                                                    90 days | Run completion                                 | Prefer redacted structured trace; purge raw untrusted content sooner                        |
| Automation runs, approvals, policy decisions, audit events                |                                                                    7 years | Event                                          | Hash/reference large evidence rather than duplicate it                                      |
| Verified webhook raw bytes                                                |                                                                     7 days | Receipt                                        | Keep normalized event ID, payload hash, signature result, transition, receipt for 24 months |
| Failed/rejected uploads                                                   |                                                                     7 days | Rejection                                      | Quarantine access restricted; delete after investigation window                             |
| OAuth/access tokens                                                       |                                           Only while integration is active | Disconnect/revoke/rotation                     | Secret manager only; remove stale grants immediately                                        |
| Daily logical database + Storage backups                                  |                                                                    30 days | Backup creation                                | Encrypt off-site; quarterly restore drill                                                   |
| Monthly recovery backup                                                   |                                                                  12 months | Backup creation                                | Separate access; legal/tax reviewer approves final period                                   |
| Security/incident evidence                                                |                                                          Per incident hold | Incident closure and hold release              | Incident owner/counsel controls release                                                     |

The implementation must expose the active policy version and next deletion date,
support dry-run impact reporting, exclude active holds, record counts/hashes, and
write an audit event after completion. Bulk deletion is a destructive action and
requires owner approval.

The schema carries retention class/expiry and legal-hold controls, but the
proposed schedule above has not been professionally approved and no production
deletion job has been authorized. Do not enable automatic purge from these
example durations.

## Data inventory and access

| Data                               | Primary system                               | Allowed roles                                                        | Prohibited use                                                           |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Customer/contact/property          | Supabase + user/company-scoped browser cache | Owner/dispatcher; technician only assigned job minimum               | List sale, unrelated marketing, model-training corpus                    |
| Property/job photos and signatures | Private Storage bucket                       | Owner/dispatcher; assigned technician; portal customer’s own records | Public bucket, permanent URL, unrelated advertising                      |
| Prices/cost/margin                 | Supabase                                     | Owner/dispatcher; technician only approved scope                     | LLM-generated replacement, customer exposure of internal costs           |
| Payment state                      | Supabase provider receipt                    | Owner/dispatcher; portal customer’s own invoice                      | Card storage, screenshot-based paid state                                |
| Communication/consent              | Supabase                                     | Owner/dispatcher; technician only job-specific                       | Sending after suppression, cross-channel inference                       |
| AI trace/approval/audit            | Supabase/telemetry                           | Owner and authorized technical reviewer                              | Technician/customer browsing, prompt content as truth                    |
| SDS/SOP/equipment                  | Supabase/Storage                             | All field roles for approved work                                    | AI-authored chemical directions, inaccessible online-only emergency copy |
| Provider secrets                   | Secret manager                               | Runtime identity and designated owner                                | Browser bundle, database row, logs, export, AI prompt                    |

RLS is mandatory for browser-accessible Supabase data. Service-role access is
reserved for narrowly scoped server/operations paths and must never be a client
fallback.

The V1 browser cache is scoped by signed-in user/company and purged on sign-out
or identity mismatch, but WashOps does not provide application-level
encryption for IndexedDB. Production device encryption, OS/browser access,
session lifetime, lost-device response, managed-device policy, and whether
offline customer data is permitted are manual YELLOW privacy/security gates.

An operational company pause preserves pending device packets so the kill
switch cannot cause offline evidence loss. The paused recovery projection does
not expose the packet body: diagnostics are limited to command/media kind,
status, and creation time, plus last server-verified time and a bounded recovery
error. It must never render or log customer/entity identifiers, command
payloads, notes, photo bytes/thumbnails, or signature data. Packets cannot sync
while paused and remain subject to the same device encryption, loss response,
retention, sign-out, identity-mismatch, and legal-hold decisions.

## Customer notice and requests

**REQUIRED PRIVACY LEGAL REVIEW:** counsel must determine applicability and exact
notice/request/appeal obligations. The Texas Attorney General says the Texas
Data Privacy and Security Act has applied since July 1, 2024, describes consumer
rights and controller duties, and notes a limited small-business treatment with
an exception concerning sale of sensitive data:
[Texas Data Privacy and Security Act overview](https://www.texasattorneygeneral.gov/consumer-protection/file-consumer-complaint/consumer-privacy-rights/texas-data-privacy-and-security-act).
Do not infer an exemption from company size alone, and do not sell personal or
sensitive data.

The approved workflow should:

1. Log the request without copying identity documents into general notes.
2. Verify identity proportionately and prevent social-engineering disclosure.
3. Search customer, property, portal, communications, Storage, campaigns,
   provider exports, AI traces, offline queues, and backups/holds.
4. Classify access, correction, deletion, portability, opt-out, or appeal.
5. Route legal/ambiguous/held records to approval.
6. Execute idempotently and reconcile provider deletion where applicable.
7. Deliver through an authenticated/secure channel.
8. Record a minimal receipt: request ID, verification method, policy version,
   systems checked, disposition, approvals, completion time, and response hash.

## Location, photos, and signatures

**REQUIRED PRIVACY/BIOMETRIC/CONTRACT LEGAL REVIEW:** exact addresses, route
locations, timestamps, photographs, image metadata, people/license plates, and
signatures can create sensitive or evidentiary records. Counsel must approve
notice, authorization, access, redaction, portal display, advertising reuse, and
retention.

- Strip unnecessary EXIF/GPS from customer-facing derivatives; preserve an
  original only when the approved evidence policy requires it.
- Avoid faces, neighboring property, interiors, license plates, and unrelated
  people. If incident evidence necessarily includes them, restrict access.
- A photo-analysis result stores evidence, confidence, unknowns, model/version,
  and human disposition. It never becomes a measurement or material fact merely
  because confidence is high.
- A signature links the signed terms/scope hash and signer assertion at that
  time. Never detach and reuse an image of a signature.

## Payment and finance data

- Stripe-hosted pages collect card data. WashOps stores provider customer/
  checkout/invoice/payment IDs, decimal amounts, currency, timestamps, and
  verified status—not card numbers, CVC, bank credentials, or checkout-session
  secrets.
- QuickBooks export contains only fields approved by the accountant. Encrypt the
  artifact, restrict it to owner/accountant, hash it, and expire it after import
  and reconciliation under the approved policy.
- Refund, bank, vendor, and destructive finance actions always require approval.

**REQUIRED TAX/FINANCIAL LEGAL REVIEW:** the tax professional approves financial
record content and retention; the payment provider does not make that
determination.

## Backup privacy

Logical database dumps and Storage exports contain customer evidence and are
classified as production-sensitive:

- write owner-only files/directories;
- encrypt at rest with a separately managed key before off-site transfer;
- use a dedicated least-privilege database credential on a trusted runner;
- never print database URLs/service-role keys;
- keep database and Storage manifests together;
- validate SHA-256 before restore;
- restrict restore to a disposable/fresh target by default;
- destroy test restores after evidence is recorded;
- test that a restored portal cannot cross company/customer boundaries.

Supabase states that database backups do not include Storage object bytes:
[Supabase Database Backups](https://supabase.com/docs/guides/platform/backups).
The WashOps backup script exports Storage only when explicitly requested with a
server-side service-role credential and records each object checksum.

## Breach and security incident handoff

Any suspected unauthorized access, disclosure, loss, credential exposure,
ransomware, altered evidence, cross-tenant/portal access, or public Storage
object is an incident—not a routine support ticket.

1. Preserve evidence and timestamps; do not “clean up” original logs.
2. Contain using the incident runbook; rotate/revoke affected credentials.
3. Identify systems, data categories, people, jurisdictions, providers, and
   earliest/latest exposure.
4. Notify the owner, security reviewer, insurer, and counsel through the
   approved escalation path.
5. Let counsel determine notifications, regulator reports, law enforcement, and
   customer language. AI may draft facts for review but may not send legal/
   breach conclusions.

**REQUIRED BREACH-NOTIFICATION LEGAL REVIEW:** the Texas Attorney General
currently states that incidents affecting 250 or more Texans must be reported
to the AG as soon as practicable and no later than 30 days after discovery, and
that affected consumers must also be notified:
[Texas AG Data Breach Reporting](https://www.texasattorneygeneral.gov/consumer-protection/data-breach-reporting).
Counsel must apply the current statute and every affected jurisdiction to the
facts; thresholds do not eliminate other notification duties.
