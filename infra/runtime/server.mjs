import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = process.env.HOST || '0.0.0.0';
const port = Number.parseInt(process.env.PORT || '8080', 10);
const root = resolve(fileURLToPath(new URL('./dist', import.meta.url)));
const startedAt = new Date().toISOString();
const buildMetadataPath = resolve(root, 'storyops-build.json');

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`PORT must be an integer from 1 through 65535; received "${process.env.PORT}".`);
}
if (!existsSync(resolve(root, 'index.html'))) {
  throw new Error(`Built application is missing at ${root}.`);
}
if (!existsSync(buildMetadataPath)) {
  throw new Error(`Compiled build metadata is missing at ${buildMetadataPath}.`);
}

let buildMetadata;
try {
  buildMetadata = JSON.parse(readFileSync(buildMetadataPath, 'utf8'));
} catch {
  throw new Error(`Compiled build metadata is invalid at ${buildMetadataPath}.`);
}
if (
  !buildMetadata ||
  typeof buildMetadata !== 'object' ||
  !['sandbox', 'supabase'].includes(buildMetadata.dataMode) ||
  typeof buildMetadata.revision !== 'string' ||
  !/^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,127}$/u.test(buildMetadata.revision)
) {
  throw new Error('Compiled build metadata must contain a valid dataMode and revision.');
}
const expectedDataMode = process.env.STORYOPS_EXPECTED_DATA_MODE?.trim();
if (expectedDataMode && !['sandbox', 'supabase'].includes(expectedDataMode)) {
  throw new Error('STORYOPS_EXPECTED_DATA_MODE must be sandbox or supabase.');
}
if (expectedDataMode && expectedDataMode !== buildMetadata.dataMode) {
  throw new Error(
    `Compiled data mode "${buildMetadata.dataMode}" does not match expected startup mode "${expectedDataMode}".`,
  );
}

const mediaTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const securityHeaders = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.weather.gov https://*.googleapis.com",
    "font-src 'self' data:",
    "form-action 'self' https://checkout.stripe.com",
    "frame-ancestors 'none'",
    'frame-src https://checkout.stripe.com',
    "img-src 'self' data: blob: https:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    'upgrade-insecure-requests',
  ].join('; '),
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=(self), payment=(self)',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    ...securityHeaders,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function safeAssetPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes('\0')) return undefined;
  const candidate = resolve(root, `.${normalize(decoded)}`);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : undefined;
}

const server = createServer((request, response) => {
  const requestStarted = performance.now();
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  response.on('finish', () => {
    process.stdout.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'http_request',
        method: request.method,
        path: requestUrl.pathname,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - requestStarted),
      })}\n`,
    );
  });

  if (!['GET', 'HEAD'].includes(request.method || '')) {
    response.setHeader('Allow', 'GET, HEAD');
    sendJson(response, 405, { error: 'method_not_allowed' });
    return;
  }

  if (requestUrl.pathname === '/healthz') {
    sendJson(response, 200, {
      status: 'healthy',
      service: 'storyops-ai-web',
      dataMode: buildMetadata.dataMode,
      revision: buildMetadata.revision,
      startedAt,
      checkedAt: new Date().toISOString(),
    });
    return;
  }

  const requestedPath = safeAssetPath(requestUrl.pathname);
  if (!requestedPath) {
    sendJson(response, 400, { error: 'invalid_path' });
    return;
  }

  const isFile = existsSync(requestedPath) && statSync(requestedPath).isFile();
  const selectedPath = isFile ? requestedPath : resolve(root, 'index.html');
  const extension = extname(selectedPath).toLowerCase();
  const immutable = selectedPath.includes(`${sep}assets${sep}`) && isFile;
  const stats = statSync(selectedPath);

  response.writeHead(200, {
    ...securityHeaders,
    'Cache-Control': immutable
      ? 'public, max-age=31536000, immutable'
      : 'no-cache, max-age=0, must-revalidate',
    'Content-Length': stats.size,
    'Content-Type': mediaTypes.get(extension) || 'application/octet-stream',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(selectedPath).pipe(response);
});

server.listen(port, host, () => {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'server_started',
      host,
      port,
      root,
      dataMode: buildMetadata.dataMode,
      revision: buildMetadata.revision,
    })}\n`,
  );
});

function shutdown(signal) {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      event: 'server_shutdown',
      signal,
    })}\n`,
  );
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
