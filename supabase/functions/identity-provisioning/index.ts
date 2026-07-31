import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  consumeOperationBudget,
  positiveIntegerSetting,
} from '../../../src/core/integrations/operationBudget.ts';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import { assertLaunchStart, assertProviderInvocation } from '../_shared/provider-authorization.ts';
import {
  identityInvitationAttemptStateSchema,
  identityInviteMode,
  identityInviteRedirectUrl,
  identityProvisioningReceiptSchema,
  identityProvisioningStateSchema,
  verifyIdentityProvisioningRequest,
} from './contracts.ts';
import {
  findExactIdentityByEmail,
  IdentityInviteSubmissionError,
  submitExactIdentityInvite,
  type IdentityAdminDirectory,
} from './directory.ts';
import { executeIdentityInviteSubmission } from './invite-authority.ts';

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) {
    throw new HttpError(
      'The trusted identity boundary is not configured.',
      503,
      'IDENTITY_SERVER_CREDENTIALS_UNAVAILABLE',
    );
  }
  return value;
}

const commandContextSchema = z
  .object({
    schemaVersion: z.literal('storyops-identity-provisioning-command-v1'),
    companyId: z.string().uuid(),
    actorUserId: z.string().uuid(),
    commandId: z.string().uuid(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    action: z.enum(['invite', 'link', 'revoke']),
    email: z.string().email(),
    role: z.enum(['dispatcher', 'technician', 'customer']),
    customerId: z.string().uuid().nullable(),
    targetUserId: z.string().uuid().nullable(),
    inviteAttemptAuthorized: z.boolean(),
    terminal: z.literal(false),
    replayed: z.boolean(),
  })
  .strict();

function safeRpcError(message: string): HttpError {
  if (/SERVICE_ROLE_REQUIRED|ACTIVE_OWNER_REQUIRED|NOT_AUTHORIZED/iu.test(message)) {
    return new HttpError(
      'Only a current owner of an active company may change identity access.',
      403,
      'IDENTITY_OWNER_REQUIRED',
    );
  }
  if (/NOT_FOUND|USER_REQUIRED|EMAIL_NOT_CONFIRMED/iu.test(message)) {
    return new HttpError(
      'The exact confirmed identity is not ready to be linked.',
      409,
      'IDENTITY_NOT_READY',
    );
  }
  if (/CONFLICT|MISMATCH|INVALID|BINDING|ALREADY_LINKED/iu.test(message)) {
    return new HttpError(
      'The identity request conflicts with current authoritative state.',
      409,
      'IDENTITY_CONFLICT',
    );
  }
  return new HttpError(
    'The trusted identity boundary is unavailable.',
    503,
    'IDENTITY_BOUNDARY_UNAVAILABLE',
  );
}

type IdentityRpcClient = {
  rpc(
    name: string,
    parameters: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

async function invokeRpc(
  client: unknown,
  name: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await (client as IdentityRpcClient).rpc(name, parameters);
  if (error) throw safeRpcError(error.message);
  return data;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
  }

  try {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) {
      throw new HttpError('Authentication is required.', 401, 'UNAUTHENTICATED');
    }
    const serviceClient = createClient(
      requiredEnvironment('SUPABASE_URL'),
      requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const {
      data: { user },
      error: authError,
    } = await serviceClient.auth.getUser(authorization.slice('Bearer '.length));
    if (authError || !user) {
      throw new HttpError('Authentication token is invalid.', 401, 'UNAUTHENTICATED');
    }

    const rawBody = await readTextBody(request, 8_192);
    let rawInput: unknown;
    try {
      rawInput = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    let parsed: Awaited<ReturnType<typeof verifyIdentityProvisioningRequest>>;
    try {
      parsed = await verifyIdentityProvisioningRequest(rawInput);
    } catch {
      throw new HttpError(
        'Identity provisioning request is invalid.',
        400,
        'INVALID_IDENTITY_REQUEST',
      );
    }
    const inviteMode = identityInviteMode(Deno.env.toObject());

    if (parsed.operation === 'state') {
      const [data, rawAttemptState] = await Promise.all([
        invokeRpc(serviceClient, 'load_storyops_identity_provisioning_state', {
          p_company_id: parsed.companyId,
          p_actor_user_id: user.id,
        }),
        invokeRpc(serviceClient, 'load_storyops_identity_invitation_attempt_state', {
          p_company_id: parsed.companyId,
          p_actor_user_id: user.id,
        }),
      ]);
      const attemptState = identityInvitationAttemptStateSchema.parse(rawAttemptState);
      const stateRecord = data as Record<string, unknown>;
      if (
        stateRecord.companyId !== parsed.companyId ||
        attemptState.companyId !== parsed.companyId ||
        stateRecord.companyStatus !== attemptState.companyStatus
      ) {
        throw new HttpError(
          'Invitation attempt authority did not match the exact company.',
          409,
          'IDENTITY_CONTEXT_MISMATCH',
        );
      }
      return jsonResponse(
        identityProvisioningStateSchema.parse({
          ...stateRecord,
          inviteMode,
          inviteSubmissionOnly: true,
          externalDeliveryClaimed: false,
          unresolvedAttempts: attemptState.unresolvedAttempts,
        }),
      );
    }

    const { request: command } = parsed;
    const activeActor = z
      .object({
        company_id: z.string().uuid(),
        user_id: z.string().uuid(),
        role: z.enum(['owner', 'dispatcher', 'technician']),
        active: z.literal(true),
      })
      .parse(
        await invokeRpc(serviceClient, 'load_storyops_edge_actor', {
          p_company_id: command.companyId,
          p_actor_user_id: user.id,
        }),
      );
    if (
      activeActor.company_id !== command.companyId ||
      activeActor.user_id !== user.id ||
      activeActor.role !== 'owner'
    ) {
      throw new HttpError(
        'Only a current owner of an active company may change identity access.',
        403,
        'IDENTITY_OWNER_REQUIRED',
      );
    }
    let budget;
    try {
      budget = await consumeOperationBudget({
        client: serviceClient,
        companyId: command.companyId,
        scope: 'identity_provisioning:user:hour',
        subject: `${user.id}:${command.action}`,
        limit: positiveIntegerSetting(
          Deno.env.get('IDENTITY_PROVISIONING_RATE_LIMIT_PER_HOUR'),
          30,
          'IDENTITY_PROVISIONING_RATE_LIMIT_PER_HOUR',
        ),
        windowSeconds: 3_600,
      });
    } catch {
      throw new HttpError(
        'The durable identity operation budget is unavailable.',
        503,
        'IDENTITY_RATE_LIMIT_UNAVAILABLE',
      );
    }
    if (!budget.allowed) {
      throw new HttpError(
        `Identity operation limit reached; retry after ${budget.reset_at}.`,
        429,
        'IDENTITY_RATE_LIMITED',
      );
    }

    const begun = await invokeRpc(serviceClient, 'begin_storyops_identity_provisioning', {
      p_company_id: command.companyId,
      p_actor_user_id: user.id,
      p_command_id: command.commandId,
      p_action: command.action,
      p_normalized_email: command.email,
      p_target_role: command.role,
      p_customer_id: command.customerId,
      p_canonical_request: parsed.canonicalRequest,
      p_request_hash: parsed.requestHash,
    });
    const terminal = identityProvisioningReceiptSchema.safeParse(begun);
    if (terminal.success) return jsonResponse(terminal.data);
    const context = commandContextSchema.parse(begun);
    if (
      context.companyId !== command.companyId ||
      context.actorUserId !== user.id ||
      context.commandId !== command.commandId ||
      context.requestHash !== parsed.requestHash ||
      context.action !== command.action ||
      context.email !== command.email ||
      context.role !== command.role ||
      context.customerId !== command.customerId
    ) {
      throw new HttpError(
        'Identity command context did not match the exact request.',
        409,
        'IDENTITY_CONTEXT_MISMATCH',
      );
    }

    const admin = serviceClient.auth.admin as unknown as IdentityAdminDirectory;
    let exactUser;
    try {
      exactUser = await findExactIdentityByEmail(admin, command.email);
    } catch {
      throw new HttpError(
        'The exact identity could not be resolved from the trusted directory.',
        503,
        'IDENTITY_DIRECTORY_UNAVAILABLE',
      );
    }

    if (command.action === 'invite') {
      if (exactUser) {
        const receipt = await invokeRpc(serviceClient, 'record_storyops_identity_observation', {
          p_company_id: command.companyId,
          p_actor_user_id: user.id,
          p_command_id: command.commandId,
          p_request_hash: parsed.requestHash,
          p_target_user_id: exactUser.id,
          p_status: 'pending',
          p_delivery_status: 'not_requested',
          p_outcome_code: 'existing_identity_requires_link',
        });
        return jsonResponse(identityProvisioningReceiptSchema.parse(receipt));
      }
      if (context.inviteAttemptAuthorized) {
        const receipt = await invokeRpc(serviceClient, 'record_storyops_identity_invite_blocked', {
          p_company_id: command.companyId,
          p_actor_user_id: user.id,
          p_command_id: command.commandId,
          p_request_hash: parsed.requestHash,
        });
        return jsonResponse(identityProvisioningReceiptSchema.parse(receipt));
      }
      if (inviteMode === 'disabled') {
        const receipt = await invokeRpc(serviceClient, 'record_storyops_identity_observation', {
          p_company_id: command.companyId,
          p_actor_user_id: user.id,
          p_command_id: command.commandId,
          p_request_hash: parsed.requestHash,
          p_target_user_id: null,
          p_status: 'pending',
          p_delivery_status: 'disabled',
          p_outcome_code: 'invite_delivery_disabled',
        });
        return jsonResponse(identityProvisioningReceiptSchema.parse(receipt));
      }

      let redirectTo: string;
      try {
        redirectTo = identityInviteRedirectUrl(Deno.env.toObject());
      } catch {
        throw new HttpError(
          'Live identity invitation has no valid trusted redirect.',
          503,
          'IDENTITY_INVITE_CONFIGURATION_INVALID',
        );
      }
      const deploymentFingerprint = await assertProviderInvocation(serviceClient, {
        companyId: command.companyId,
        provider: 'supabase_auth',
        capability: 'identity_invitation',
        operationClass: 'launch_start',
      });
      await assertLaunchStart(serviceClient, {
        companyId: command.companyId,
        capability: 'customer_contact',
      });
      let receipt;
      try {
        receipt = await executeIdentityInviteSubmission({
          expected: {
            companyId: command.companyId,
            commandId: command.commandId,
            requestHash: parsed.requestHash,
            email: command.email,
            role: command.role,
          },
          authorize: () =>
            invokeRpc(serviceClient, 'authorize_storyops_identity_invite', {
              p_company_id: command.companyId,
              p_actor_user_id: user.id,
              p_command_id: command.commandId,
              p_request_hash: parsed.requestHash,
              p_deployment_fingerprint: deploymentFingerprint,
            }),
          recordSubmissionUnknown: async () =>
            identityProvisioningReceiptSchema.parse(
              await invokeRpc(serviceClient, 'record_storyops_identity_invite_blocked', {
                p_company_id: command.companyId,
                p_actor_user_id: user.id,
                p_command_id: command.commandId,
                p_request_hash: parsed.requestHash,
              }),
            ),
          submitProviderOnce: async () => {
            let invited;
            try {
              invited = await submitExactIdentityInvite(admin, {
                email: command.email,
                redirectTo,
                companyId: command.companyId,
                role: command.role,
              });
            } catch (caught) {
              const unknown =
                caught instanceof IdentityInviteSubmissionError && caught.outcome === 'unknown';
              return identityProvisioningReceiptSchema.parse(
                await invokeRpc(serviceClient, 'record_storyops_identity_observation', {
                  p_company_id: command.companyId,
                  p_actor_user_id: user.id,
                  p_command_id: command.commandId,
                  p_request_hash: parsed.requestHash,
                  p_target_user_id: null,
                  p_status: 'pending',
                  p_delivery_status: unknown
                    ? 'provider_submission_unknown'
                    : 'provider_submission_failed',
                  p_outcome_code: unknown
                    ? 'invite_submission_unknown'
                    : 'invite_submission_failed',
                }),
              );
            }
            return identityProvisioningReceiptSchema.parse(
              await invokeRpc(serviceClient, 'record_storyops_identity_observation', {
                p_company_id: command.companyId,
                p_actor_user_id: user.id,
                p_command_id: command.commandId,
                p_request_hash: parsed.requestHash,
                p_target_user_id: invited.id,
                p_status: 'invited',
                p_delivery_status: 'provider_submission_accepted',
                p_outcome_code: 'invite_submission_accepted',
              }),
            );
          },
        });
      } catch (caught) {
        if (
          caught instanceof Error &&
          (caught.message.includes('IDENTITY_INVITE_AUTHORIZATION_MISMATCH') ||
            caught.name === 'ZodError')
        ) {
          throw new HttpError(
            'Invitation authority did not match the exact request.',
            409,
            'IDENTITY_CONTEXT_MISMATCH',
          );
        }
        throw caught;
      }
      return jsonResponse(receipt);
    }

    if (command.action === 'link') {
      if (!exactUser || !exactUser.emailConfirmedAt) {
        const receipt = await invokeRpc(serviceClient, 'record_storyops_identity_observation', {
          p_company_id: command.companyId,
          p_actor_user_id: user.id,
          p_command_id: command.commandId,
          p_request_hash: parsed.requestHash,
          p_target_user_id: exactUser?.id ?? null,
          p_status: 'pending',
          p_delivery_status: 'not_requested',
          p_outcome_code: exactUser ? 'identity_confirmation_required' : 'identity_not_found',
        });
        return jsonResponse(identityProvisioningReceiptSchema.parse(receipt));
      }
      const receipt = await invokeRpc(serviceClient, 'link_storyops_identity', {
        p_company_id: command.companyId,
        p_actor_user_id: user.id,
        p_command_id: command.commandId,
        p_request_hash: parsed.requestHash,
        p_target_user_id: exactUser.id,
      });
      return jsonResponse(identityProvisioningReceiptSchema.parse(receipt));
    }

    const receipt = await invokeRpc(serviceClient, 'revoke_storyops_identity', {
      p_company_id: command.companyId,
      p_actor_user_id: user.id,
      p_command_id: command.commandId,
      p_request_hash: parsed.requestHash,
      p_target_user_id: exactUser?.id ?? context.targetUserId,
    });
    return jsonResponse(identityProvisioningReceiptSchema.parse(receipt));
  } catch (error) {
    return errorResponse(error);
  }
});
