import { z } from 'zod';
import { resolveLiveProviderActivation } from '../../../src/core/integrations/configuration.ts';
import {
  canonicalIdentityRequestText,
  identityInvitationAttemptStateSchema,
  identityProvisioningEdgeRequestSchema,
  identityProvisioningReceiptSchema,
  identityProvisioningStateSchema,
  identityRequestSha256,
  normalizeIdentityEmail,
} from '../../../src/core/identity/provisioning.ts';

export {
  identityInvitationAttemptStateSchema,
  identityProvisioningEdgeRequestSchema,
  identityProvisioningReceiptSchema,
  identityProvisioningStateSchema,
  normalizeIdentityEmail,
};

export type IdentityDirectoryUser = Readonly<{
  id: string;
  email: string;
  emailConfirmedAt?: string;
  invitedAt?: string;
}>;

export async function verifyIdentityProvisioningRequest(
  value: unknown,
): Promise<z.infer<typeof identityProvisioningEdgeRequestSchema>> {
  const request = identityProvisioningEdgeRequestSchema.parse(value);
  if (request.operation === 'state') return request;
  const expectedCanonical = canonicalIdentityRequestText(request.request);
  if (
    request.canonicalRequest !== expectedCanonical ||
    (await identityRequestSha256(request.canonicalRequest)) !== request.requestHash
  ) {
    throw new Error('IDENTITY_REQUEST_HASH_MISMATCH');
  }
  return request;
}

export function identityInviteMode(
  environment: Record<string, string | undefined>,
): 'disabled' | 'live' {
  return resolveLiveProviderActivation(
    environment,
    'STORYOPS_IDENTITY_INVITE_LIVE_ENABLED',
    'STORYOPS_IDENTITY_INVITE_MODE',
  ).enabled
    ? 'live'
    : 'disabled';
}

export function identityInviteRedirectUrl(environment: Record<string, string | undefined>): string {
  const raw = environment.STORYOPS_IDENTITY_INVITE_REDIRECT_URL?.trim();
  if (!raw) throw new Error('IDENTITY_INVITE_REDIRECT_UNAVAILABLE');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('IDENTITY_INVITE_REDIRECT_INVALID');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('IDENTITY_INVITE_REDIRECT_INVALID');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('IDENTITY_INVITE_REDIRECT_INVALID');
  }
  return url.toString();
}
