const allowedOrigin = Deno.env.get('APP_ORIGIN') ?? 'http://localhost:5173';

export const corsHeaders = {
  'access-control-allow-origin': allowedOrigin,
  'access-control-allow-headers':
    'authorization, apikey, content-type, x-client-info, x-request-id',
  'access-control-allow-methods': 'POST, OPTIONS',
  vary: 'origin',
};

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

export function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  const status = error instanceof HttpError ? error.status : 500;
  return jsonResponse(
    {
      error: status >= 500 ? 'Internal server error.' : message,
      code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR',
    },
    status,
  );
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export async function readTextBody(request: Request, maxBytes = 1_000_000): Promise<string> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > maxBytes) {
    throw new HttpError('Request body is too large.', 413, 'PAYLOAD_TOO_LARGE');
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > maxBytes) {
    throw new HttpError('Request body is too large.', 413, 'PAYLOAD_TOO_LARGE');
  }
  return body;
}
