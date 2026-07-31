import { z } from 'zod';

export const identityInviteAuthorizationSchema = z
  .object({
    authorized: z.literal(true),
    attemptAlreadyAuthorized: z.boolean(),
    companyId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    email: z.string().email(),
    role: z.enum(['dispatcher', 'technician', 'customer']),
  })
  .strict();

type IdentityInviteAuthorization = z.infer<typeof identityInviteAuthorizationSchema>;

export type IdentityInviteAuthorizationBinding = Readonly<
  Pick<IdentityInviteAuthorization, 'companyId' | 'commandId' | 'requestHash' | 'email' | 'role'>
>;

export function parseIdentityInviteAuthorization(
  value: unknown,
  expected: IdentityInviteAuthorizationBinding,
): IdentityInviteAuthorization {
  const authorization = identityInviteAuthorizationSchema.parse(value);
  if (
    authorization.companyId !== expected.companyId ||
    authorization.commandId !== expected.commandId ||
    authorization.requestHash !== expected.requestHash ||
    authorization.email !== expected.email ||
    authorization.role !== expected.role
  ) {
    throw new Error('IDENTITY_INVITE_AUTHORIZATION_MISMATCH');
  }
  return authorization;
}

export async function executeIdentityInviteSubmission<T>(input: {
  authorize: () => Promise<unknown>;
  expected: IdentityInviteAuthorizationBinding;
  recordSubmissionUnknown: () => Promise<T>;
  submitProviderOnce: () => Promise<T>;
}): Promise<T> {
  const authorization = parseIdentityInviteAuthorization(await input.authorize(), input.expected);
  if (authorization.attemptAlreadyAuthorized) {
    return input.recordSubmissionUnknown();
  }
  return input.submitProviderOnce();
}
