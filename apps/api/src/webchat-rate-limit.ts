/**
 * #1044: limits for the public widget routes. The visitor is anonymous, so the limits are counted per
 * client address and, because an address can be forged behind a proxy, per widget as a whole too.
 * Counters live in this process; they bound abuse and are not an exact quota.
 */
export class WebchatRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; used: number }>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Returns the seconds to wait when the key has used its allowance for the window, otherwise null. */
  consume(key: string, limit: number, windowMs: number): number | null {
    const now = this.now();
    this.sweep(now);
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      this.windows.set(key, { startedAt: now, used: 1 });
      return null;
    }
    if (current.used < limit) {
      current.used += 1;
      return null;
    }
    return Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000));
  }

  /** Forgets windows older than ten minutes so the map does not grow with every visitor ever seen. */
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows)
      if (now - window.startedAt > 600_000) this.windows.delete(key);
  }
}
