export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
};

export interface RateLimiter {
  consume(key: string, now?: Date): Promise<RateLimitDecision>;
}

export class InMemorySlidingWindowRateLimiter implements RateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isInteger(limit) || limit <= 0 || windowMs <= 0) {
      throw new Error('Rate limit and window must be positive.');
    }
  }

  async consume(key: string, now = new Date()): Promise<RateLimitDecision> {
    const current = now.getTime();
    const cutoff = current - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((time) => time > cutoff);
    const allowed = recent.length < this.limit;
    if (allowed) recent.push(current);
    this.attempts.set(key, recent);
    const earliest = recent[0] ?? current;
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - recent.length),
      resetAt: new Date(earliest + this.windowMs).toISOString(),
    };
  }
}
