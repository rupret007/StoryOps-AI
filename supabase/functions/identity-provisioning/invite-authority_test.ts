import {
  executeIdentityInviteSubmission,
  parseIdentityInviteAuthorization,
  type IdentityInviteAuthorizationBinding,
} from './invite-authority.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertRejects(
  operation: () => unknown | Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes(code)) return;
    throw error;
  }
  throw new Error(`Expected rejection containing ${code}.`);
}

const expected: IdentityInviteAuthorizationBinding = {
  companyId: '10000000-0000-4000-8000-000000000001',
  commandId: '51000000-0000-4000-8000-000000000101',
  requestHash: 'a'.repeat(64),
  email: 'concurrent-invite@example.com',
  role: 'technician',
};

function authorization(
  binding: IdentityInviteAuthorizationBinding,
  attemptAlreadyAuthorized: boolean,
): Record<string, unknown> {
  return {
    authorized: true,
    attemptAlreadyAuthorized,
    ...binding,
  };
}

Deno.test(
  'different commands and roles for one email invoke the identity provider exactly once',
  async () => {
    let enteredAuthorization = 0;
    let releaseBarrier: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let attemptClaimed = false;
    let providerInvocations = 0;
    let unknownReceipts = 0;

    const runRequest = (binding: IdentityInviteAuthorizationBinding) =>
      executeIdentityInviteSubmission({
        expected: binding,
        authorize: async () => {
          enteredAuthorization += 1;
          if (enteredAuthorization === 2) releaseBarrier?.();
          await barrier;

          // This synchronous critical section models the database row lock in
          // authorize_storyops_identity_invite: only the first waiter claims
          // the durable logical-target invitation-attempt authority.
          const attemptAlreadyAuthorized = attemptClaimed;
          attemptClaimed = true;
          return authorization(binding, attemptAlreadyAuthorized);
        },
        recordSubmissionUnknown: () => {
          unknownReceipts += 1;
          return Promise.resolve('provider_submission_unknown');
        },
        submitProviderOnce: () => {
          providerInvocations += 1;
          return Promise.resolve('provider_submission_accepted');
        },
      });

    const results = await Promise.all([
      runRequest(expected),
      runRequest({
        ...expected,
        commandId: '51000000-0000-4000-8000-000000000102',
        requestHash: 'b'.repeat(64),
        role: 'dispatcher',
      }),
    ]);

    assert(enteredAuthorization === 2, 'both requests did not reach the authorization barrier');
    assert(providerInvocations === 1, 'the external identity provider was invoked more than once');
    assert(unknownReceipts === 1, 'the losing request did not record unknown provider truth');
    assert(
      results.includes('provider_submission_accepted') &&
        results.includes('provider_submission_unknown'),
      'concurrent requests did not preserve accepted/unknown outcomes',
    );
  },
);

Deno.test('same-command retries invoke the identity provider exactly once', async () => {
  let enteredAuthorization = 0;
  let releaseBarrier: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let attemptClaimed = false;
  let providerInvocations = 0;
  let unknownReceipts = 0;

  const runRequest = () =>
    executeIdentityInviteSubmission({
      expected,
      authorize: async () => {
        enteredAuthorization += 1;
        if (enteredAuthorization === 2) releaseBarrier?.();
        await barrier;
        const attemptAlreadyAuthorized = attemptClaimed;
        attemptClaimed = true;
        return authorization(expected, attemptAlreadyAuthorized);
      },
      recordSubmissionUnknown: () => {
        unknownReceipts += 1;
        return Promise.resolve('provider_submission_unknown');
      },
      submitProviderOnce: () => {
        providerInvocations += 1;
        return Promise.resolve('provider_submission_accepted');
      },
    });

  await Promise.all([runRequest(), runRequest()]);

  assert(providerInvocations === 1, 'a same-command retry invoked the provider twice');
  assert(unknownReceipts === 1, 'a same-command retry did not preserve unknown provider truth');
});

Deno.test(
  'authorization response is strict and bound to the exact invitation request',
  async () => {
    let providerInvocations = 0;

    await assertRejects(
      () =>
        executeIdentityInviteSubmission({
          expected,
          authorize: () =>
            Promise.resolve({
              ...authorization(expected, false),
              unexpectedProviderField: true,
            }),
          recordSubmissionUnknown: () => Promise.resolve('unknown'),
          submitProviderOnce: () => {
            providerInvocations += 1;
            return Promise.resolve('submitted');
          },
        }),
      'Unrecognized key',
    );
    await assertRejects(() => {
      parseIdentityInviteAuthorization(authorization(expected, false), {
        ...expected,
        commandId: '51000000-0000-4000-8000-000000000102',
      });
    }, 'IDENTITY_INVITE_AUTHORIZATION_MISMATCH');

    assert(providerInvocations === 0, 'an invalid authorization response reached the provider');
  },
);
