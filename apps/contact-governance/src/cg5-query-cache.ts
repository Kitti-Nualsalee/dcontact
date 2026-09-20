import { stableDigest } from './cg3-persistence.js';
import type { Cg5QueryScope } from './cg5-query-service.js';

/** Minimal Redis surface; failures are deliberately treated as a cache miss. */
export interface Cg5QueryCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

type CacheEntry<T> = { asOf: string; expiresAt: string; value: T };

export class Cg5QueryCache {
  constructor(
    private readonly client: Cg5QueryCacheClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  key(input: {
    tenantId: string;
    kind: 'metrics' | 'policy-impact' | 'alerts';
    scope: Cg5QueryScope;
    query: unknown;
  }): string {
    // Scope stays in the digest even when callers happen to request the same filters.
    return `cg5:query:${input.kind}:${input.tenantId}:${stableDigest({ scope: input.scope, query: input.query })}`;
  }

  async getOrLoad<T extends { asOf: Date | null }>(input: {
    key: string;
    refreshIntervalSeconds: number;
    load: () => Promise<T>;
  }): Promise<T> {
    const cached = await this.read<T>(input.key);
    if (cached) return cached;
    const loaded = await input.load();
    // No cache entry may outlive the tenant's declared refresh interval.
    const ttlSeconds = Math.max(1, Math.floor(input.refreshIntervalSeconds));
    await this.write(input.key, loaded, ttlSeconds);
    return loaded;
  }

  private async read<T extends { asOf: Date | null }>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.client.get(key);
      if (!raw) return undefined;
      const entry = JSON.parse(raw) as CacheEntry<T>;
      if (
        !entry ||
        typeof entry.expiresAt !== 'string' ||
        this.now() >= new Date(entry.expiresAt)
      ) {
        return undefined;
      }
      return entry.value;
    } catch {
      return undefined;
    }
  }

  private async write<T extends { asOf: Date | null }>(key: string, value: T, ttlSeconds: number) {
    const now = this.now();
    const entry: CacheEntry<T> = {
      asOf: value.asOf?.toISOString() ?? now.toISOString(),
      expiresAt: new Date(now.valueOf() + ttlSeconds * 1_000).toISOString(),
      value,
    };
    try {
      await this.client.set(key, JSON.stringify(entry), 'EX', ttlSeconds);
    } catch {
      // Redis is optional for this reader. The direct projection result remains valid.
    }
  }
}
