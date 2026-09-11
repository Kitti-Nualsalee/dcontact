import type { Redis } from 'ioredis';

/**
 * Immutable snapshot cache + mutable head invalidation สำหรับ CG3 (#104 "Kafka,
 * cache, realtime และ submission race"). Redis ไม่ใช่ source of truth — ห้าม cache
 * final ALLOW, reservation หรือผล authorizeAndReserve() ข้าม actionKey (ADR-003)
 *
 * key convention:
 *   cg:contact:{tenantId}:{contactId}:{aggregateVersion}  — immutable snapshot, TTL
 *   cg:policy:{tenantId}:{policyId}:{policyVersion}       — immutable snapshot, TTL
 *   cg:contact:{tenantId}:{contactId}:head                — mutable, no TTL, invalidate on new event
 *   cg:policy:{tenantId}:{policyId}:head                  — mutable, no TTL, invalidate on new event
 */

const DEFAULT_SNAPSHOT_TTL_SECONDS = 3_600;

export interface Cg3CacheOptions {
  snapshotTtlSeconds?: number;
}

export class Cg3Cache {
  private readonly snapshotTtlSeconds: number;

  constructor(
    private readonly redis: Redis,
    options: Cg3CacheOptions = {},
  ) {
    this.snapshotTtlSeconds = options.snapshotTtlSeconds ?? DEFAULT_SNAPSHOT_TTL_SECONDS;
  }

  private contactSnapshotKey(tenantId: string, contactId: string, version: number): string {
    return `cg:contact:${tenantId}:${contactId}:${version}`;
  }

  private policySnapshotKey(tenantId: string, policyId: string, version: number): string {
    return `cg:policy:${tenantId}:${policyId}:${version}`;
  }

  private contactHeadKey(tenantId: string, contactId: string): string {
    return `cg:contact:${tenantId}:${contactId}:head`;
  }

  private policyHeadKey(tenantId: string, policyId: string): string {
    return `cg:policy:${tenantId}:${policyId}:head`;
  }

  async setContactSnapshot(
    tenantId: string,
    contactId: string,
    version: number,
    snapshot: unknown,
  ): Promise<void> {
    await this.redis.set(
      this.contactSnapshotKey(tenantId, contactId, version),
      JSON.stringify(snapshot),
      'EX',
      this.snapshotTtlSeconds,
    );
  }

  async getContactSnapshot<T>(
    tenantId: string,
    contactId: string,
    version: number,
  ): Promise<T | undefined> {
    const raw = await this.redis.get(this.contactSnapshotKey(tenantId, contactId, version));
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  async setPolicySnapshot(
    tenantId: string,
    policyId: string,
    version: number,
    snapshot: unknown,
  ): Promise<void> {
    await this.redis.set(
      this.policySnapshotKey(tenantId, policyId, version),
      JSON.stringify(snapshot),
      'EX',
      this.snapshotTtlSeconds,
    );
  }

  async getPolicySnapshot<T>(
    tenantId: string,
    policyId: string,
    version: number,
  ): Promise<T | undefined> {
    const raw = await this.redis.get(this.policySnapshotKey(tenantId, policyId, version));
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  async getContactHead(tenantId: string, contactId: string): Promise<number | undefined> {
    const raw = await this.redis.get(this.contactHeadKey(tenantId, contactId));
    return raw ? Number(raw) : undefined;
  }

  async getPolicyHead(tenantId: string, policyId: string): Promise<number | undefined> {
    const raw = await this.redis.get(this.policyHeadKey(tenantId, policyId));
    return raw ? Number(raw) : undefined;
  }

  /** เรียกหลัง publish event สำเร็จ — บังคับ reader รอบถัดไป fallback ไปอ่าน canonical DB */
  async invalidateContactHead(tenantId: string, contactId: string): Promise<void> {
    await this.redis.del(this.contactHeadKey(tenantId, contactId));
  }

  async invalidatePolicyHead(tenantId: string, policyId: string): Promise<void> {
    await this.redis.del(this.policyHeadKey(tenantId, policyId));
  }
}
