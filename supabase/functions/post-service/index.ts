import { createClient } from '@supabase/supabase-js';
import {
  HttpError,
  corsHeaders,
  errorResponse,
  jsonResponse,
  readTextBody,
} from '../_shared/http.ts';
import {
  postServiceRequestSchema,
  postServiceResponseSchema,
  type PostServiceRequest,
} from './contracts.ts';

type JsonObject = Record<string, unknown>;

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required server environment variable ${name}.`);
  return value;
}

function actionDetails(input: PostServiceRequest): JsonObject {
  if (input.action === 'maintenance.activate') {
    return {
      cadence: input.cadence,
      nextDueDate: input.nextDueDate,
      ...(input.intervalDays === undefined ? {} : { intervalDays: input.intervalDays }),
    };
  }
  return { channel: input.channel };
}

function postServiceHttpError(message: string): HttpError {
  const mappings: Array<[string, number, string, string]> = [
    [
      'POST_SERVICE_ROLE_REQUIRED',
      403,
      'FORBIDDEN',
      'This role cannot create post-service actions.',
    ],
    [
      'POST_SERVICE_CUSTOMER_SCOPE_REQUIRED',
      403,
      'FORBIDDEN',
      'This invoice is not linked to the authenticated portal customer.',
    ],
    [
      'POST_SERVICE_INVOICE_VERSION_CONFLICT',
      409,
      'VERSION_CONFLICT',
      'The invoice changed; refresh before continuing.',
    ],
    [
      'POST_SERVICE_IDEMPOTENCY_CONFLICT',
      409,
      'IDEMPOTENCY_CONFLICT',
      'The command ID was reused for a different post-service action.',
    ],
    [
      'POST_SERVICE_COMMAND_IN_PROGRESS',
      409,
      'COMMAND_IN_PROGRESS',
      'The same post-service command is already in progress.',
    ],
    [
      'POST_SERVICE_ACTION_ALREADY_EXISTS',
      409,
      'ACTION_ALREADY_EXISTS',
      'A different post-service action already exists for this invoice.',
    ],
    [
      'POST_SERVICE_CURRENT_CONSENT_REQUIRED',
      422,
      'CONSENT_REQUIRED',
      'Current marketing consent for the selected channel is required.',
    ],
    [
      'POST_SERVICE_PROVIDER_PAID_INVOICE_REQUIRED',
      422,
      'PAID_INVOICE_REQUIRED',
      'A provider-confirmed paid invoice with zero balance is required.',
    ],
    [
      'POST_SERVICE_COMPLETED_JOB_REQUIRED',
      422,
      'COMPLETED_JOB_REQUIRED',
      'The invoice must be backed by a completed job and completed visits.',
    ],
    [
      'POST_SERVICE_ACCEPTED_PRICING_REQUIRED',
      422,
      'ACCEPTED_PRICING_REQUIRED',
      'The completed job must retain an accepted deterministic pricing snapshot.',
    ],
    [
      'GOLDEN_PATH_',
      422,
      'ACCEPTED_PRICING_REQUIRED',
      'The accepted deterministic pricing snapshot no longer validates.',
    ],
  ];
  const mapping = mappings.find(([needle]) => message.includes(needle));
  return mapping
    ? new HttpError(mapping[3], mapping[1], mapping[2])
    : new HttpError('The post-service action was not allowed.', 422, 'POST_SERVICE_NOT_ALLOWED');
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
    let input: unknown;
    try {
      input = JSON.parse(rawBody);
    } catch {
      throw new HttpError('Request body must be valid JSON.', 400, 'INVALID_JSON');
    }
    const parsed = postServiceRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(
        'Request contains invalid or unsupported post-service fields.',
        400,
        'INVALID_REQUEST',
      );
    }

    const { data, error } = await serviceClient.rpc('execute_storyops_post_service_action', {
      p_company_id: parsed.data.companyId,
      p_actor_user_id: user.id,
      p_command_id: parsed.data.commandId,
      p_action: parsed.data.action,
      p_invoice_id: parsed.data.invoiceId,
      p_expected_version: parsed.data.expectedVersion,
      p_details: actionDetails(parsed.data),
    });
    if (error) throw postServiceHttpError(error.message);

    const response = postServiceResponseSchema.parse(data);
    if (
      response.companyId !== parsed.data.companyId ||
      response.commandId !== parsed.data.commandId ||
      response.invoiceId !== parsed.data.invoiceId ||
      response.invoiceVersion !== parsed.data.expectedVersion ||
      response.action !== parsed.data.action
    ) {
      throw new HttpError(
        'The post-service receipt identity did not match the request.',
        502,
        'INVALID_DATABASE_RECEIPT',
      );
    }
    return jsonResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
});
