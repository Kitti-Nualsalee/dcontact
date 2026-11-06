import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';

/** Redis-backed fixed-window budgets. Both keys are checked and charged atomically. */
export interface SharedRateLimitInput {
  tenantId: string;
  actorId: string;
  policy: { name: string; actorLimit: number; tenantLimit: number; windowMs: number };
}

export interface SharedRateLimiter {
  consume(input: SharedRateLimitInput): Promise<{ retryAfterSeconds: number } | null>;
}

export const CUSTOMER_360_SEARCH_LIMITER = Symbol('CUSTOMER_360_SEARCH_LIMITER');
export const C360_WRITE_POLICY = Object.freeze({
  name: 'c360-write-v1',
  actorLimit: 30,
  tenantLimit: 300,
  windowMs: 60_000,
});
export const C360_RECEIPT_POLICY = Object.freeze({
  name: 'c360-receipt-v1',
  actorLimit: 120,
  tenantLimit: 1200,
  windowMs: 60_000,
});
export const C360_SEARCH_POLICY = Object.freeze({
  name: 'c360-search-v1',
  actorLimit: 60,
  tenantLimit: 600,
  windowMs: 60_000,
});

// A missing/invalid TTL is a corrupt counter, never a reason to reset the budget.
const CONSUME = `
local function state(key)
  local value = redis.call('GET', key)
  if not value then return 0, 0 end
  local count = tonumber(value)
  local ttl = redis.call('PTTL', key)
  if not count or count < 0 or count ~= math.floor(count) or ttl < 0 then
    return redis.error_reply('invalid rate limit state')
  end
  return count, math.max(1, ttl)
end
local actor, actorTtl = state(KEYS[1])
local tenant, tenantTtl = state(KEYS[2])
local wait = 0
if actor >= tonumber(ARGV[1]) then wait = math.max(wait, actorTtl) end
if tenant >= tonumber(ARGV[2]) then wait = math.max(wait, tenantTtl) end
if wait > 0 then return {0, wait} end
for _, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 0 then
    redis.call('SET', key, 1, 'PX', ARGV[3])
  else
    redis.call('INCR', key)
  end
end
return {1, 0}
`;

type RedisEval = {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class RedisSharedRateLimiter implements SharedRateLimiter {
  constructor(private readonly redis: RedisEval) {}

  async consume(input: SharedRateLimitInput): Promise<{ retryAfterSeconds: number } | null> {
    const { name, actorLimit, tenantLimit, windowMs } = input.policy;
    if (
      !/^[a-z0-9-]{1,64}$/.test(name) ||
      !input.tenantId ||
      !input.actorId ||
      ![actorLimit, tenantLimit, windowMs].every((n) => Number.isSafeInteger(n) && n > 0)
    ) {
      throw new TypeError('Invalid rate limit policy');
    }
    const prefix = `dc:rate:{${digest(input.tenantId)}}:${name}`;
    const result = await this.redis.eval(
      CONSUME,
      2,
      `${prefix}:actor:${digest(input.actorId)}`,
      `${prefix}:tenant`,
      String(actorLimit),
      String(tenantLimit),
      String(windowMs),
    );
    if (!Array.isArray(result) || result.length !== 2) throw new Error('Invalid rate limit result');
    const [allowed, wait] = result;
    if (allowed === 1 && wait === 0) return null;
    if (allowed === 0 && Number.isSafeInteger(wait) && wait > 0 && wait <= windowMs) {
      return { retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
    }
    throw new Error('Invalid rate limit result');
  }
}

/** Missing or invalid configuration fails search closed without preventing unrelated API routes from starting. */
export function createCustomer360SearchLimiter(redisUrl: string | undefined): SharedRateLimiter {
  const unavailable: SharedRateLimiter = {
    async consume() {
      throw new Error('Redis rate limiter unavailable');
    },
  };
  if (!redisUrl?.trim()) return unavailable;
  try {
    const redis = new Redis(redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false,
      connectTimeout: 1000,
      commandTimeout: 1000,
    });
    // Do not log connection URLs or credentials.
    redis.on('error', () => undefined);
    return new RedisSharedRateLimiter(redis);
  } catch {
    return unavailable;
  }
}
