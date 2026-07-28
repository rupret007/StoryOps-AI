import { IntegrationError } from './contracts.ts';

export const JOB_MEDIA_UPLOAD_MAX_BYTES = 26_214_400;
export const SUPABASE_SIGNED_UPLOAD_EXPIRES_SECONDS = 7_200;

const companySegmentPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function validatedSegments(value: string): string[] {
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    !value ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    hasControlCharacter
  ) {
    throw new IntegrationError(
      'Storage object paths must be relative, printable, and slash-delimited.',
      'storage',
      'INVALID_OBJECT_PATH',
      false,
    );
  }
  const segments = value.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new IntegrationError(
      'Storage object paths cannot contain empty or traversal segments.',
      'storage',
      'INVALID_OBJECT_PATH',
      false,
    );
  }
  return segments;
}

export function scopeStorageObjectKey(companyId: string, proposedObjectKey: string): string {
  if (!companySegmentPattern.test(companyId)) {
    throw new IntegrationError(
      'The company storage scope is invalid.',
      'storage',
      'INVALID_COMPANY_SCOPE',
      false,
    );
  }
  const segments = validatedSegments(proposedObjectKey);
  const relativeSegments = segments[0] === companyId ? segments.slice(1) : segments;
  if (relativeSegments.length === 0) {
    throw new IntegrationError(
      'A storage object name is required beneath the company scope.',
      'storage',
      'INVALID_OBJECT_PATH',
      false,
    );
  }
  const scoped = [companyId, ...relativeSegments].join('/');
  if (scoped.length > 1_024) {
    throw new IntegrationError(
      'The company-scoped storage object path is too long.',
      'storage',
      'INVALID_OBJECT_PATH',
      false,
    );
  }
  return scoped;
}

export function assertStorageObjectKeyScope(companyId: string, objectKey: string): void {
  if (scopeStorageObjectKey(companyId, objectKey) !== objectKey) {
    throw new IntegrationError(
      'The storage object path is outside the active company scope.',
      'storage',
      'CROSS_COMPANY_OBJECT_PATH',
      false,
    );
  }
}
