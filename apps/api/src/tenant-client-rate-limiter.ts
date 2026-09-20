/** Reusable fixed-window limiter keyed by verified tenant and service client identifiers. */
export class TenantClientRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; used: number }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  consume(input: {
    tenantId: string;
    clientId: string;
    limitPerMinute: number;
  }): { retryAfterSeconds: number } | null {
    if (!Number.isInteger(input.limitPerMinute) || input.limitPerMinute < 1) {
      throw new TypeError('limitPerMinute ต้องเป็น positive integer');
    }
    const now = this.now().valueOf();
    const key = `${input.tenantId}:${input.clientId}`;
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      this.windows.set(key, { startedAt: now, used: 1 });
      return null;
    }
    if (current.used < input.limitPerMinute) {
      current.used += 1;
      return null;
    }
    return {
      retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - current.startedAt)) / 1_000)),
    };
  }
}
