import {
  canonicalIdentityRequestText,
  identityRequestSha256,
} from '../../../src/core/identity/provisioning.ts';
import {
  identityInvitationAttemptStateSchema,
  identityInviteMode,
  identityInviteRedirectUrl,
  verifyIdentityProvisioningRequest,
} from './contracts.ts';
import {
  findExactIdentityByEmail,
  submitExactIdentityInvite,
  type IdentityAdminDirectory,
} from './directory.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRejects(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(code)) return;
    throw error;
  }
  throw new Error(`Expected rejection containing ${code}.`);
}

const canonical = {
  schemaVersion: 'storyops-identity-provisioning-request-v1' as const,
  companyId: '10000000-0000-4000-8000-000000000001',
  commandId: '46000000-0000-4000-8000-000000000001',
  action: 'invite' as const,
  email: 'field@example.com',
  role: 'technician' as const,
  customerId: null,
};

Deno.test(
  'identity request binds its complete canonical request and rejects tampering',
  async () => {
    const canonicalRequest = canonicalIdentityRequestText(canonical);
    const requestHash = await identityRequestSha256(canonicalRequest);
    const parsed = await verifyIdentityProvisioningRequest({
      operation: 'command',
      request: canonical,
      canonicalRequest,
      requestHash,
    });
    assert(
      parsed.operation === 'command' && parsed.requestHash === requestHash,
      'request mismatch',
    );

    await assertRejects(
      () =>
        verifyIdentityProvisioningRequest({
          operation: 'command',
          request: { ...canonical, role: 'dispatcher' },
          canonicalRequest,
          requestHash,
        }),
      'IDENTITY_REQUEST_HASH_MISMATCH',
    );
  },
);

Deno.test('identity invite delivery is disabled by default and redirect is server-owned', () => {
  assert(identityInviteMode({}) === 'disabled', 'default mode must be disabled');
  assert(
    identityInviteMode({
      STORYOPS_IDENTITY_INVITE_MODE: 'live',
      STORYOPS_IDENTITY_INVITE_LIVE_ENABLED: 'false',
    }) === 'disabled',
    'mode alone enabled invitation submission',
  );
  assert(
    identityInviteMode({
      STORYOPS_IDENTITY_INVITE_MODE: 'disabled',
      STORYOPS_IDENTITY_INVITE_LIVE_ENABLED: 'true',
    }) === 'disabled',
    'live flag alone enabled invitation submission',
  );
  assert(
    identityInviteMode({
      STORYOPS_IDENTITY_INVITE_MODE: 'live',
      STORYOPS_IDENTITY_INVITE_LIVE_ENABLED: 'true',
    }) === 'live',
    'dual live activation was not recognized',
  );
  assert(
    identityInviteRedirectUrl({
      STORYOPS_IDENTITY_INVITE_REDIRECT_URL: 'https://app.example.com/access',
    }) === 'https://app.example.com/access',
    'trusted redirect mismatch',
  );
  let blocked = false;
  try {
    identityInviteRedirectUrl({
      STORYOPS_IDENTITY_INVITE_REDIRECT_URL: 'http://app.example.com/access',
    });
  } catch {
    blocked = true;
  }
  assert(blocked, 'insecure non-loopback redirect was accepted');
});

Deno.test('unresolved invitation authority is finite and owner-actionable', () => {
  const state = identityInvitationAttemptStateSchema.parse({
    schemaVersion: 'storyops-identity-invitation-attempt-state-v1',
    companyId: canonical.companyId,
    companyStatus: 'active',
    unresolvedAttempts: [
      {
        id: '51000000-0000-4000-8000-000000000201',
        email: 'field@example.com',
        originatingRole: 'technician',
        originatingCustomerId: null,
        providerCommandId: canonical.commandId,
        authorityStatus: 'provider_submission_unknown',
        authorizedAt: '2026-07-30T12:00:00.000Z',
        observedAt: '2026-07-30T12:00:01.000Z',
        expiresAt: '2026-08-06T12:00:00.000Z',
        retryEligible: false,
        reconciliationRequired: true,
      },
    ],
    serverTime: '2026-07-30T12:01:00.000Z',
  });
  assert(state.unresolvedAttempts.length === 1, 'unresolved authority was not projected');
  assert(
    !('providerResponse' in state.unresolvedAttempts[0]),
    'provider response leaked through owner state',
  );
});

Deno.test('directory lookup returns only an exact normalized email', async () => {
  const calls: Array<{ page: number; perPage: number }> = [];
  const directory: IdentityAdminDirectory = {
    listUsers(input) {
      calls.push(input);
      return Promise.resolve({
        data: {
          users: [
            {
              id: '10000000-0000-4000-8000-000000000102',
              email: 'dispatcher@example.com',
              email_confirmed_at: '2026-07-30T12:00:00.000Z',
            },
          ],
        },
        error: null,
      });
    },
    inviteUserByEmail() {
      return Promise.reject(new Error('invite must not run during lookup'));
    },
  };
  const found = await findExactIdentityByEmail(directory, ' Dispatcher@Example.com ', {
    perPage: 100,
  });
  assert(found?.email === 'dispatcher@example.com', 'exact identity not found');
  assert(calls.length === 1, 'directory lookup did not stop after exact match');
});

Deno.test('disabled-mode behavior never calls the external invite method', async () => {
  let inviteCalls = 0;
  const directory: IdentityAdminDirectory = {
    listUsers() {
      return Promise.resolve({ data: { users: [] }, error: null });
    },
    inviteUserByEmail() {
      inviteCalls += 1;
      return Promise.resolve({ data: null, error: { message: 'must not be called' } });
    },
  };

  const mode = identityInviteMode({});
  await findExactIdentityByEmail(directory, 'new@example.com', { perPage: 100 });
  if (mode === 'live') {
    await submitExactIdentityInvite(directory, {
      email: 'new@example.com',
      redirectTo: 'https://app.example.com/access',
      companyId: canonical.companyId,
      role: 'technician',
    });
  }
  assert(inviteCalls === 0, 'disabled mode submitted an external invite');
});

Deno.test(
  'live invite validates the exact returned identity without claiming delivery',
  async () => {
    let inviteCalls = 0;
    const directory: IdentityAdminDirectory = {
      listUsers() {
        return Promise.resolve({ data: { users: [] }, error: null });
      },
      inviteUserByEmail(email) {
        inviteCalls += 1;
        return Promise.resolve({
          data: {
            user: {
              id: '10000000-0000-4000-8000-000000000103',
              email,
              invited_at: '2026-07-30T12:00:00.000Z',
            },
          },
          error: null,
        });
      },
    };
    const invited = await submitExactIdentityInvite(directory, {
      email: 'new@example.com',
      redirectTo: 'https://app.example.com/access',
      companyId: canonical.companyId,
      role: 'technician',
    });
    assert(invited.email === 'new@example.com', 'invite identity mismatch');
    assert(invited.emailConfirmedAt === undefined, 'invite falsely claimed confirmation');
    assert(inviteCalls === 1, 'invite submission count mismatch');
  },
);

Deno.test('invite adapter preserves known failure versus unknown submission truth', async () => {
  const rejectedDirectory: IdentityAdminDirectory = {
    listUsers() {
      return Promise.resolve({ data: { users: [] }, error: null });
    },
    inviteUserByEmail() {
      return Promise.resolve({
        data: null,
        error: { message: 'Provider rejected the request.', status: 422 },
      });
    },
  };
  await assertRejects(
    () =>
      submitExactIdentityInvite(rejectedDirectory, {
        email: 'rejected@example.com',
        redirectTo: 'https://app.example.com/access',
        companyId: canonical.companyId,
        role: 'dispatcher',
      }),
    'IDENTITY_INVITE_SUBMISSION_FAILED',
  );

  const uncertainDirectory: IdentityAdminDirectory = {
    listUsers() {
      return Promise.resolve({ data: { users: [] }, error: null });
    },
    inviteUserByEmail() {
      return Promise.reject(new Error('Connection ended after request transmission.'));
    },
  };
  await assertRejects(
    () =>
      submitExactIdentityInvite(uncertainDirectory, {
        email: 'uncertain@example.com',
        redirectTo: 'https://app.example.com/access',
        companyId: canonical.companyId,
        role: 'technician',
      }),
    'IDENTITY_INVITE_SUBMISSION_UNKNOWN',
  );
});
