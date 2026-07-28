import {
  asISODateTime,
  deriveIdempotencyKey,
  executeIdempotently,
  hashIdempotencyPayload,
  IdempotencyConflictError,
  type IdempotencyContext,
  type IdempotencyReservation,
  type IdempotencyStore,
  type JsonValue,
} from '@/domain';

class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<
    string,
    { hash: string; state: 'in_progress' | 'completed'; response?: JsonValue }
  >();

  public async reserve(context: IdempotencyContext): Promise<IdempotencyReservation> {
    await Promise.resolve();
    const existing = this.records.get(context.key);
    if (!existing) {
      this.records.set(context.key, { hash: context.requestHash, state: 'in_progress' });
      return { status: 'reserved' };
    }
    if (existing.hash !== context.requestHash) {
      return { status: 'conflict', existingRequestHash: existing.hash };
    }
    if (existing.state === 'completed') {
      return { status: 'completed', response: existing.response ?? null };
    }
    return { status: 'in_progress' };
  }

  public async complete(context: IdempotencyContext, response: JsonValue): Promise<void> {
    await Promise.resolve();
    this.records.set(context.key, {
      hash: context.requestHash,
      state: 'completed',
      response,
    });
  }

  public async release(context: IdempotencyContext): Promise<void> {
    await Promise.resolve();
    this.records.delete(context.key);
  }
}

describe('idempotency', () => {
  it('canonicalizes object keys before hashing', async () => {
    await expect(hashIdempotencyPayload({ b: 2, a: 1 })).resolves.toBe(
      await hashIdempotencyPayload({ a: 1, b: 2 }),
    );
    const derived = await deriveIdempotencyKey('quote', { b: 2, a: 1 });
    expect(derived.key).toMatch(/^quote:[a-f0-9]{32}$/u);
    expect(derived.requestHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('runs once and replays the stored response for duplicate requests', async () => {
    const store = new MemoryIdempotencyStore();
    const requestHash = await hashIdempotencyPayload({ quoteId: 'quote-1' });
    const context: IdempotencyContext = {
      key: 'send-quote:key-1',
      scope: 'send-quote',
      requestHash,
      requestedAt: asISODateTime('2026-07-28T12:00:00.000-05:00'),
    };
    const operation = vi.fn(() => Promise.resolve({ providerMessageId: 'mock-1' }));

    await expect(executeIdempotently(store, context, operation)).resolves.toEqual({
      replayed: false,
      value: { providerMessageId: 'mock-1' },
    });
    await expect(executeIdempotently(store, context, operation)).resolves.toEqual({
      replayed: true,
      value: { providerMessageId: 'mock-1' },
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a key with a different request hash', async () => {
    const store = new MemoryIdempotencyStore();
    const base: IdempotencyContext = {
      key: 'payment:key-1',
      scope: 'payment',
      requestHash: 'a'.repeat(64),
      requestedAt: asISODateTime('2026-07-28T12:00:00.000-05:00'),
    };
    await executeIdempotently(store, base, () => Promise.resolve({ ok: true }));

    await expect(
      executeIdempotently(store, { ...base, requestHash: 'b'.repeat(64) }, () =>
        Promise.resolve({ ok: false }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
