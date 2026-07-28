# Authenticated live setup runbook

**Audience:** trusted Supabase administrator and the company owner  
**Status:** implemented onboarding boundary; hosted auth/RLS canary still required  
**Last reviewed:** 2026-07-28

This runbook authorizes one signed-in owner to provision one StoryOps company in
`setup` status. It does not authorize launch, publish pricing or terms, activate
services or providers, contact a customer, or move money.

## Security boundary

The browser receives only the public Supabase URL, public anon key, and a random
company UUID. A new company can be created only when the authenticated user's
protected Supabase `app_metadata.storyops_bootstrap_company_id` exactly matches
that configured UUID.

- Set the claim only through a trusted Supabase administrative boundary.
- Never use `user_metadata`; users can edit it.
- Never place the service-role key, database password, or any other secret in a
  `VITE_` variable, browser, ticket, screenshot, or client log.
- A public company UUID is not authority. The server rejects an identity without
  the protected matching invitation.
- A customer-portal identity, an identity already scoped to another company, or
  an identity attempting to claim an existing company is rejected.

## Issue the one-company invitation

1. Generate a cryptographically random UUID for the new company. Record the
   intended owner, issuer, timestamp, and UUID in the administrative change
   record.
2. Configure the reviewed browser build with:

   ```text
   VITE_STORYOPS_DATA_MODE=supabase
   VITE_SUPABASE_URL=<public project URL>
   VITE_SUPABASE_ANON_KEY=<public anon key>
   VITE_STORYOPS_COMPANY_ID=<random company UUID>
   ```

3. Through the Supabase dashboard or a trusted server using the Supabase Admin
   API, create/invite the intended owner and set protected app metadata to:

   ```json
   {
     "storyops_bootstrap_company_id": "<the same random company UUID>"
   }
   ```

4. Confirm that the email belongs to the intended owner. Do not delegate the
   invitation to an AI agent or accept an owner-supplied JWT.
5. Have the owner sign in through the StoryOps magic-link screen. A successful
   invitation yields `status: "required"` from
   `get_storyops_setup_state(company_uuid)`; it does not create a company yet.

Existing local seed users already have durable memberships and do not need this
bootstrap claim. Never use the local seed or its passwords in a hosted project.

## Complete and verify setup

1. In the wizard, enter the verified business/owner names, five-digit home ZIP,
   and currently offered services.
2. Review the acknowledgement. It describes the records that will be created;
   the screen does not claim they exist before confirmation.
3. Choose **Create setup workspace** once. The client derives a stable command
   UUID and SHA-256 request hash; the server replays only the exact same request
   and rejects a changed payload.
4. Retain the server receipt and `company.setup_completed` audit event.
5. Verify all of the following from an administrative read-only connection:

   - one company exists at the invited UUID with `status = 'setup'`;
   - the intended user has one active `owner` membership;
   - `setupWizardCompleted` is true and `launchAuthorized` is false;
   - only the selected service drafts exist and every one is inactive;
   - the price book, service terms, and retention policy are drafts requiring
     review, with no invented/published price;
   - all ten integration records are disabled; and
   - the setup audit event and request ID match the retained receipt.

6. After verification, remove the bootstrap claim through the same trusted
   administrative boundary and require a fresh session. The durable membership,
   not a lingering invitation, is the ongoing authorization source.

Ordinary owner updates cannot alter company lifecycle status or the
server-managed setup/launch evidence keys. A future launch must use a separately
reviewed finite administrative command or migration with attached approval
evidence.

## Failure and recovery

- If the RPC is rejected, the UI remains on an unconfirmed review screen. Do not
  describe the workspace as ready.
- An exact retry returns the original idempotent setup receipt and must not
  duplicate company artifacts or audit events.
- A different request using the same stable command is a conflict. Stop and
  review the original receipt and company state.
- A partially populated or non-pristine setup company fails closed. Do not
  delete or overwrite it merely to retry; open an incident and use a reviewed
  corrective migration.
- If the invitation went to the wrong identity, revoke its sessions and access,
  clear the protected claim, preserve audit evidence, rotate any exposed
  credentials, and follow the integration/security incident playbook.

Before real operations, complete the hosted authentication, cross-role RLS,
private Storage, backup/restore, observability, rollback, provider, and DFW
professional-review gates in the release status and launch checklist.
