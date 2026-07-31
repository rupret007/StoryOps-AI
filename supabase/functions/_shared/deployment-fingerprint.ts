import { integrationDeploymentRequiredSettings } from '../../../src/core/integrations/environmentHealth.ts';

export async function storyopsDeploymentFingerprint(
  environment: Record<string, string | undefined>,
  signingKey: string,
): Promise<string> {
  const canonical = ['STORYOPS_RELEASE_ID', ...integrationDeploymentRequiredSettings(environment)]
    .map((name) => `${name}\u001f${environment[name] ?? '<missing>'}`)
    .join('\u001e');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
