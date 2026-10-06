/** Reusable fixed-window limiter keyed by verified tenant and service client identifiers. */
export class TenantClientRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; used: number }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  consume(input: {
    tenantId: string;
    clientId: string;
    /** จำนวนครั้งต่อ window (ชื่อเดิมจาก CG5 — window เริ่มต้น 1 นาที) */
    limitPerMinute: number;
    /** AC4 (#597): ความยาว window เช่น 1 ชม. สำหรับ self-service บัญชี */
    windowMs?: number;
  }): { retryAfterSeconds: number } | null {
    if (!Number.isInteger(input.limitPerMinute) || input.limitPerMinute < 1) {
      throw new TypeError('limitPerMinute ต้องเป็น positive integer');
    }
    const windowMs = input.windowMs ?? 60_000;
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new TypeError('windowMs ต้องเป็น positive integer');
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
