import { AiOfficeError } from './contracts.ts';

export type IdempotencyRecord<T> = {
  requestHash: string;
  value: T;
  expiresAt: number;
};

export interface IdempotencyStore {
  get<T>(scope: string, key: string): Promise<IdempotencyRecord<T> | undefined>;
  put<T>(scope: string, key: string, record: IdempotencyRecord<T>): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord<unknown>>();

  async get<T>(scope: string, key: string): Promise<IdempotencyRecord<T> | undefined> {
    const mapKey = `${scope}:${key}`;
    const record = this.records.get(mapKey);
    if (!record) return undefined;
    if (record.expiresAt <= Date.now()) {
      this.records.delete(mapKey);
      return undefined;
    }
    return record as IdempotencyRecord<T>;
  }

  async put<T>(scope: string, key: string, record: IdempotencyRecord<T>): Promise<void> {
    this.records.set(`${scope}:${key}`, record);
  }
}

const inflight = new WeakMap<IdempotencyStore, Map<string, Promise<unknown>>>();

export async function executeIdempotently<T>(options: {
  store: IdempotencyStore;
  scope: string;
  key: string;
  requestHash: string;
  ttlMs: number;
  execute: () => Promise<T>;
}): Promise<{ value: T; replayed: boolean }> {
  const { store, scope, key, requestHash, ttlMs, execute } = options;
  const existing = await store.get<T>(scope, key);
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new AiOfficeError(
        `Idempotency key "${key}" was already used with a different request.`,
        'IDEMPOTENCY_CONFLICT',
      );
    }
    return { value: existing.value, replayed: true };
  }

  const storeInflight = inflight.get(store) ?? new Map<string, Promise<unknown>>();
  inflight.set(store, storeInflight);
  const inflightKey = `${scope}:${key}`;
  const pending = storeInflight.get(inflightKey);
  if (pending) {
    const result = (await pending) as { value: T; requestHash: string };
    if (result.requestHash !== requestHash) {
      throw new AiOfficeError(
        `Idempotency key "${key}" is already in flight with a different request.`,
        'IDEMPOTENCY_CONFLICT',
      );
    }
    return { value: result.value, replayed: true };
  }

  const execution = (async () => {
    const value = await execute();
    await store.put(scope, key, {
      requestHash,
      value,
      expiresAt: Date.now() + ttlMs,
    });
    return { value, requestHash };
  })();

  storeInflight.set(inflightKey, execution);
  try {
    const result = await execution;
    return { value: result.value, replayed: false };
  } finally {
    storeInflight.delete(inflightKey);
  }
}
