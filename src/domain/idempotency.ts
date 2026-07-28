import type { IdempotencyContext } from './primitives.ts';

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

const canonicalize = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key] ?? null)}`)
    .join(',')}}`;
};

const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

export const hashIdempotencyPayload = async (payload: JsonValue): Promise<string> => {
  const encoded = new TextEncoder().encode(canonicalize(payload));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(digest);
};

export const deriveIdempotencyKey = async (
  scope: string,
  payload: JsonValue,
): Promise<{ key: string; requestHash: string }> => {
  const requestHash = await hashIdempotencyPayload(payload);
  return {
    key: `${scope}:${requestHash.slice(0, 32)}`,
    requestHash,
  };
};

export type IdempotencyReservation =
  | { status: 'reserved' }
  | { status: 'in_progress' }
  | { status: 'completed'; response: JsonValue }
  | { status: 'conflict'; existingRequestHash: string };

export interface IdempotencyStore {
  reserve(context: IdempotencyContext): Promise<IdempotencyReservation>;
  complete(context: IdempotencyContext, response: JsonValue): Promise<void>;
  release(context: IdempotencyContext, errorCode: string): Promise<void>;
}

export class IdempotencyConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export const executeIdempotently = async <T extends JsonValue>(
  store: IdempotencyStore,
  context: IdempotencyContext,
  operation: () => Promise<T>,
): Promise<{ replayed: boolean; value: T }> => {
  const reservation = await store.reserve(context);
  if (reservation.status === 'completed') {
    return { replayed: true, value: reservation.response as T };
  }
  if (reservation.status === 'conflict') {
    throw new IdempotencyConflictError('Idempotency key was reused with a different request.');
  }
  if (reservation.status === 'in_progress') {
    throw new IdempotencyConflictError('An operation with this idempotency key is in progress.');
  }

  try {
    const value = await operation();
    await store.complete(context, value);
    return { replayed: false, value };
  } catch (error) {
    await store.release(context, error instanceof Error ? error.name : 'UnknownError');
    throw error;
  }
};
