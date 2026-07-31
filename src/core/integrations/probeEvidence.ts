import type { IntegrationProbeEvidence } from './contracts.ts';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createIntegrationProbeEvidence(
  basis: IntegrationProbeEvidence['basis'],
  operation: string,
  normalizedResponse: unknown,
): Promise<IntegrationProbeEvidence> {
  if (!/^[a-z][a-z0-9_.-]{2,79}$/u.test(operation)) {
    throw new Error('Integration probe operation is invalid.');
  }
  return {
    schemaVersion: 'storyops-integration-probe-evidence-v1',
    basis,
    operation,
    responseDigest: await sha256Hex(
      canonicalJson({
        schemaVersion: 'storyops-integration-probe-response-v1',
        operation,
        normalizedResponse,
      }),
    ),
  };
}
