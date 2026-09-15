import type { Cg4Digest } from '@d-contact/cxa-contracts';

/**
 * CG4.6 (#189): the cache contract from #179 §5.
 *
 * Redis is a projection, never truth. Nothing here may hold a final `ALLOW`, a
 * reservation, approval authority or an idempotency result — only immutable snapshots
 * keyed by version+digest, and mutable heads that carry an explicit `validUntil`. A head
 * past `validUntil`, a miss, or an unavailable Redis all resolve the same way: the caller
 * reads canonical state, and fails closed if it cannot.
 */

/** The subset of ioredis this cache needs; a test double implements the same three calls. */
export interface Cg4CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export interface Cg4CachedHead {
  version: number;
  digest: Cg4Digest;
  /** ISO-8601. `min(TTL, nextActivationAt)` at write time. */
  validUntil: string;
  nextActivationAt?: string;
}

export type Cg4CachedHeadResolution =
  | { usable: true; head: Cg4CachedHead }
  | { usable: false; reason: 'MISS' | 'EXPIRED' | 'MALFORMED' | 'UNAVAILABLE' };

/**
 * Pure: a head entry is usable only strictly before `validUntil`. At the boundary it is
 * already expired, which is what stops a scheduled activation from being served by a
 * cached head that pre-dates it.
 */
export function resolveCg4CachedHead(
  entry: Cg4CachedHead | undefined,
  now: Date,
): Cg4CachedHeadResolution {
  if (!entry) return { usable: false, reason: 'MISS' };
  const validUntil = new Date(entry.validUntil);
  if (Number.isNaN(validUntil.getTime())) return { usable: false, reason: 'MALFORMED' };
  if (now.getTime() >= validUntil.getTime()) return { usable: false, reason: 'EXPIRED' };
  return { usable: true, head: entry };
}

/** `validUntil = min(now + TTL, nextActivationAt)` (#176 §5). */
export function cg4HeadValidUntil(input: {
  now: Date;
  ttlSeconds: number;
  nextActivationAt?: Date | null;
}): Date {
  const ttlBound = input.now.getTime() + input.ttlSeconds * 1_000;
  return new Date(
    input.nextActivationAt ? Math.min(ttlBound, input.nextActivationAt.getTime()) : ttlBound,
  );
}

const DEFAULT_SNAPSHOT_TTL_SECONDS = 3_600;
const DEFAULT_HEAD_TTL_SECONDS = 30;

export interface Cg4CacheOptions {
  snapshotTtlSeconds?: number;
  /** Upper bound on how stale a mutable head may be even with no pending activation. */
  headTtlSeconds?: number;
  now?: () => Date;
}

export interface Cg4CacheStats {
  hits: number;
  misses: number;
  expired: number;
  /** Redis threw — the caller fell back to canonical state. */
  unavailable: number;
}

export class Cg4Cache {
  private readonly snapshotTtlSeconds: number;
  private readonly headTtlSeconds: number;
  private readonly now: () => Date;
  private readonly stats: Cg4CacheStats = { hits: 0, misses: 0, expired: 0, unavailable: 0 };

  constructor(
    private readonly client: Cg4CacheClient,
    options: Cg4CacheOptions = {},
  ) {
    this.snapshotTtlSeconds = options.snapshotTtlSeconds ?? DEFAULT_SNAPSHOT_TTL_SECONDS;
    this.headTtlSeconds = options.headTtlSeconds ?? DEFAULT_HEAD_TTL_SECONDS;
    this.now = options.now ?? (() => new Date());
  }

  /** Counters only — opaque, no identity, safe to export as metrics (#179 §7). */
  snapshotStats(): Cg4CacheStats {
    return { ...this.stats };
  }

  policySnapshotKey(tenantId: string, policyId: string, version: number, digest: string): string {
    return `cg:policy:${tenantId}:${policyId}:${version}:${digest}`;
  }

  policyHeadKey(tenantId: string, policyId: string): string {
    return `cg:policy:${tenantId}:${policyId}:head`;
  }

  exceptionSnapshotKey(
    tenantId: string,
    seriesId: string,
    version: number,
    digest: string,
  ): string {
    return `cg:exception:${tenantId}:${seriesId}:${version}:${digest}`;
  }

  exceptionHeadKey(tenantId: string, seriesId: string): string {
    return `cg:exception:${tenantId}:${seriesId}:head`;
  }

  contactSnapshotKey(tenantId: string, contactId: string, aggregateVersion: number): string {
    return `cg:contact:${tenantId}:${contactId}:${aggregateVersion}`;
  }

  /**
   * An authorization projection is only valid for the exact epoch and scope version it
   * was resolved at, so both are in the key: a revoked grant bumps the epoch and the old
   * entry becomes unreachable rather than merely stale (#179 §5).
   */
  authorizationKey(
    tenantId: string,
    subjectId: string,
    authorizationEpoch: number,
    scopeVersion: number,
  ): string {
    return `cg:authz:${tenantId}:${subjectId}:${authorizationEpoch}:${scopeVersion}`;
  }

  private async read(key: string): Promise<string | null | undefined> {
    try {
      return await this.client.get(key);
    } catch {
      this.stats.unavailable += 1;
      return undefined;
    }
  }

  private async write(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch {
      this.stats.unavailable += 1;
    }
  }

  private async drop(...keys: string[]): Promise<void> {
    try {
      await this.client.del(...keys);
    } catch {
      this.stats.unavailable += 1;
    }
  }

  /** Immutable: keyed by version+digest, so a value can never be wrong, only absent. */
  async getSnapshot<T>(key: string): Promise<T | undefined> {
    const raw = await this.read(key);
    if (raw === undefined) return undefined;
    if (raw === null) {
      this.stats.misses += 1;
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as T;
      this.stats.hits += 1;
      return parsed;
    } catch {
      this.stats.misses += 1;
      return undefined;
    }
  }

  async setSnapshot(key: string, snapshot: unknown): Promise<void> {
    await this.write(key, snapshot, this.snapshotTtlSeconds);
  }

  async getHead(key: string): Promise<Cg4CachedHeadResolution> {
    const raw = await this.read(key);
    if (raw === undefined) return { usable: false, reason: 'UNAVAILABLE' };
    if (raw === null) {
      this.stats.misses += 1;
      return { usable: false, reason: 'MISS' };
    }
    let entry: Cg4CachedHead;
    try {
      entry = JSON.parse(raw) as Cg4CachedHead;
    } catch {
      this.stats.misses += 1;
      return { usable: false, reason: 'MALFORMED' };
    }
    const resolution = resolveCg4CachedHead(entry, this.now());
    if (resolution.usable) this.stats.hits += 1;
    else if (resolution.reason === 'EXPIRED') this.stats.expired += 1;
    else this.stats.misses += 1;
    return resolution;
  }

  /**
   * Writes a mutable head with its own `validUntil`. The Redis TTL is set from the same
   * bound, so an entry cannot outlive its declared validity even if a reader forgets to
   * check — belt and braces, because a stale head is the one thing that could resurrect a
   * superseded policy.
   */
  async setHead(
    key: string,
    head: { version: number; digest: Cg4Digest; nextActivationAt?: Date | null },
  ): Promise<Cg4CachedHead> {
    const now = this.now();
    const validUntil = cg4HeadValidUntil({
      now,
      ttlSeconds: this.headTtlSeconds,
      ...(head.nextActivationAt !== undefined ? { nextActivationAt: head.nextActivationAt } : {}),
    });
    const entry: Cg4CachedHead = {
      version: head.version,
      digest: head.digest,
      validUntil: validUntil.toISOString(),
      ...(head.nextActivationAt ? { nextActivationAt: head.nextActivationAt.toISOString() } : {}),
    };
    const ttlSeconds = Math.max(1, Math.ceil((validUntil.getTime() - now.getTime()) / 1_000));
    await this.write(key, entry, ttlSeconds);
    return entry;
  }

  async invalidatePolicyHead(tenantId: string, policyId: string): Promise<void> {
    await this.drop(this.policyHeadKey(tenantId, policyId));
  }

  async invalidateExceptionHead(tenantId: string, seriesId: string): Promise<void> {
    await this.drop(this.exceptionHeadKey(tenantId, seriesId));
  }

  /**
   * Contact evaluation snapshots are keyed by aggregate version, so a new version makes
   * older entries unreachable rather than wrong; this drops the head other readers use to
   * discover which version is current.
   */
  async invalidateContactHead(tenantId: string, contactId: string): Promise<void> {
    await this.drop(`cg:contact:${tenantId}:${contactId}:head`);
  }
}
