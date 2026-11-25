/** Reusable fixed-window limiter keyed by verified tenant and service client identifiers. */
export class TenantClientRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; used: number }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  consume(input: {
    tenantId: string;
    clientId: string;
    /** the count per window (the original name from CG5 — the default window is 1 minute) */
    limitPerMinute: number;
    /** AC4 (#597): the window length, e.g. 1 hour for account self-service */
    windowMs?: number;
  }): { retryAfterSeconds: number } | null {
    if (!Number.isInteger(input.limitPerMinute) || input.limitPerMinute < 1) {
      throw new TypeError('limitPerMinute must be a positive integer');
    }
    const windowMs = input.windowMs ?? 60_000;
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new TypeError('windowMs must be a positive integer');
    }
    const now = this.now().valueOf();
    const key = `${input.tenantId}:${input.clientId}`;
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      this.windows.set(key, { startedAt: now, used: 1 });
      return null;
    }
    if (current.used < input.limitPerMinute) {
      current.used += 1;
      return null;
    }
    return {
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1_000)),
    };
  }
}
