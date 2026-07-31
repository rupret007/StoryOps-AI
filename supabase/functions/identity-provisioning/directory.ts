import { normalizeIdentityEmail, type IdentityDirectoryUser } from './contracts.ts';

type DirectoryUser = Readonly<{
  id?: unknown;
  email?: unknown;
  email_confirmed_at?: unknown;
  invited_at?: unknown;
}>;

type DirectoryError = Readonly<{ message?: string; code?: string; status?: number }>;

export interface IdentityAdminDirectory {
  listUsers(input: { page: number; perPage: number }): Promise<{
    data: { users?: DirectoryUser[] } | null;
    error: DirectoryError | null;
  }>;
  inviteUserByEmail(
    email: string,
    options: { redirectTo: string; data: Record<string, string> },
  ): Promise<{
    data: { user?: DirectoryUser | null } | null;
    error: DirectoryError | null;
  }>;
}

export class IdentityInviteSubmissionError extends Error {
  override readonly name = 'IdentityInviteSubmissionError';

  constructor(readonly outcome: 'failed' | 'unknown') {
    super(
      outcome === 'failed'
        ? 'IDENTITY_INVITE_SUBMISSION_FAILED'
        : 'IDENTITY_INVITE_SUBMISSION_UNKNOWN',
    );
  }
}

function directoryUser(value: DirectoryUser, expectedEmail: string): IdentityDirectoryUser {
  if (
    typeof value.id !== 'string' ||
    typeof value.email !== 'string' ||
    normalizeIdentityEmail(value.email) !== expectedEmail
  ) {
    throw new Error('IDENTITY_DIRECTORY_RESPONSE_MISMATCH');
  }
  return {
    id: value.id,
    email: expectedEmail,
    emailConfirmedAt:
      typeof value.email_confirmed_at === 'string' ? value.email_confirmed_at : undefined,
    invitedAt: typeof value.invited_at === 'string' ? value.invited_at : undefined,
  };
}

export async function findExactIdentityByEmail(
  admin: IdentityAdminDirectory,
  email: string,
  options: { maxPages?: number; perPage?: number } = {},
): Promise<IdentityDirectoryUser | undefined> {
  const normalizedEmail = normalizeIdentityEmail(email);
  const perPage = Math.min(1000, Math.max(1, options.perPage ?? 1000));
  const maxPages = Math.min(50, Math.max(1, options.maxPages ?? 20));
  let exact: IdentityDirectoryUser | undefined;

  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await admin.listUsers({ page, perPage });
    if (error || !data || !Array.isArray(data.users)) {
      throw new Error('IDENTITY_DIRECTORY_UNAVAILABLE');
    }
    for (const candidate of data.users) {
      let candidateEmail: string | undefined;
      try {
        candidateEmail =
          typeof candidate.email === 'string' ? normalizeIdentityEmail(candidate.email) : undefined;
      } catch {
        candidateEmail = undefined;
      }
      if (candidateEmail === normalizedEmail) {
        if (exact) throw new Error('IDENTITY_DIRECTORY_DUPLICATE_EMAIL');
        exact = directoryUser(candidate, normalizedEmail);
      }
    }
    if (exact || data.users.length < perPage) return exact;
  }

  throw new Error('IDENTITY_DIRECTORY_SCAN_LIMIT');
}

export async function submitExactIdentityInvite(
  admin: IdentityAdminDirectory,
  input: {
    email: string;
    redirectTo: string;
    companyId: string;
    role: 'dispatcher' | 'technician' | 'customer';
  },
): Promise<IdentityDirectoryUser> {
  const email = normalizeIdentityEmail(input.email);
  let response;
  try {
    response = await admin.inviteUserByEmail(email, {
      redirectTo: input.redirectTo,
      data: {
        storyops_company_id: input.companyId,
        storyops_intended_role: input.role,
      },
    });
  } catch {
    throw new IdentityInviteSubmissionError('unknown');
  }
  if (response.error) throw new IdentityInviteSubmissionError('failed');
  if (!response.data?.user) throw new IdentityInviteSubmissionError('unknown');
  try {
    return directoryUser(response.data.user, email);
  } catch {
    throw new IdentityInviteSubmissionError('unknown');
  }
}
