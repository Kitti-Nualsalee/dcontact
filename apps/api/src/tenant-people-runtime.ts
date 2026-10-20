import { randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  DatabaseTenantPeopleReadiness,
  type TenantPeopleIdentityReadiness,
} from './tenant-people-readiness.js';
import { runPeopleWorkerStep, type TenantPeopleIdentityPort } from './tenant-people-worker.js';
import { voiceUuid } from './tenant-voice-catalog.js';
import {
  acceptedExtensionMatches,
  type PeopleTelephonyNode,
} from './tenant-people-infrastructure.js';

export interface TenantPeopleWorkerIdentity
  extends TenantPeopleIdentityPort, TenantPeopleIdentityReadiness {}

export class TenantPeopleRuntime {
  private readonly readiness: DatabaseTenantPeopleReadiness;
  private readonly owner = `people-worker:${randomUUID()}`;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private running = false;
  private healthy = false;
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<number> | undefined;
  private readonly nodes: ReadonlyMap<string, readonly PeopleTelephonyNode[]>;

  constructor(
    private readonly database: PrismaClient,
    private readonly identities: ReadonlyMap<string, TenantPeopleWorkerIdentity>,
    options: {
      intervalMs?: number;
      batchSize?: number;
      nodes?: ReadonlyMap<string, readonly PeopleTelephonyNode[]>;
    } = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.batchSize = options.batchSize ?? 20;
    this.nodes = options.nodes ?? new Map();
    if (
      !Number.isInteger(this.intervalMs) ||
      this.intervalMs < 100 ||
      this.intervalMs > 60_000 ||
      !Number.isInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 100 ||
      identities.size > 100
    )
      throw new Error('INVALID_PEOPLE_RUNTIME_CONFIGURATION');
    for (const tenantId of identities.keys()) voiceUuid(tenantId, 'tenantId');
    this.readiness = new DatabaseTenantPeopleReadiness(database, identities);
  }

  async isReady(tenantId: string): Promise<boolean> {
    if (!this.running || !this.healthy) return false;
    const ready = await this.readiness.isReady(tenantId);
    return ready && this.running && this.healthy;
  }

  nodesForTenant(tenantId: string): readonly PeopleTelephonyNode[] {
    return this.nodes.get(tenantId) ?? [];
  }

  onModuleInit(): void {
    if (this.running) return;
    this.running = true;
    void this.runOnce()
      .catch(() => undefined)
      .finally(() => this.schedule());
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.healthy = false;
    if (this.timer) clearTimeout(this.timer);
    try {
      await this.inFlight;
    } catch {}
  }

  runOnce(): Promise<number> {
    if (!this.running) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    const task = this.drain()
      .then((count) => {
        this.healthy = this.running;
        return count;
      })
      .catch((error) => {
        this.healthy = false;
        throw error;
      })
      .finally(() => {
        if (this.inFlight === task) this.inFlight = undefined;
      });
    this.inFlight = task;
    return task;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(async () => {
      try {
        await this.runOnce();
      } catch {}
      this.schedule();
    }, this.intervalMs);
    this.timer.unref();
  }

  private async drain(): Promise<number> {
    const tenants = [...this.identities.keys()];
    const checked = new Map<string, boolean>();
    const deferred = new Set<string>();
    let attempts = 0,
      idle = 0;
    while (this.running && attempts < this.batchSize && idle < tenants.length) {
      const tenantId = tenants[this.cursor % tenants.length]!;
      this.cursor = (this.cursor + 1) % tenants.length;
      if (!checked.has(tenantId)) checked.set(tenantId, await this.readiness.isReady(tenantId));
      if (!checked.get(tenantId)) {
        idle++;
        continue;
      }
      if (!this.running) break;
      const candidate = await withTenantDatabaseTransaction(
        this.database,
        tenantId,
        async (transaction) => {
          const rows = await transaction.$queryRaw<
            { id: string; role: string; infrastructure: unknown }[]
          >`
          SELECT id,request_payload->>'role' AS role,request_payload->'infrastructure' AS infrastructure FROM tenant_people_operations WHERE tenant_id=${tenantId}::uuid
            AND state IN ('QUEUED','RUNNING','WAITING_EXTERNAL') AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
            AND id::text NOT IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify([...deferred])}::jsonb) AS skipped(value))
          ORDER BY updated_at,id LIMIT 1`;
          return rows[0];
        },
      );
      if (!candidate) {
        idle++;
        continue;
      }
      if (!this.running) break;
      if (
        candidate.role === 'AGENT' &&
        !acceptedExtensionMatches(candidate.infrastructure, this.nodesForTenant(tenantId))
      ) {
        deferred.add(candidate.id);
        attempts++;
        continue;
      }
      idle = 0;
      attempts++;
      const identity = this.identities.get(tenantId)!;
      const result = await runPeopleWorkerStep(
        this.database,
        identity,
        tenantId,
        candidate.id,
        this.owner,
      );
      const state = await withTenantDatabaseTransaction(
        this.database,
        tenantId,
        async (transaction) => {
          const rows = await transaction.$queryRaw<
            { state: string }[]
          >`SELECT state FROM tenant_people_operations WHERE tenant_id=${tenantId}::uuid AND id=${candidate.id}::uuid`;
          return rows[0]?.state;
        },
      );
      if (result !== 'RECORDED' || state !== 'QUEUED') deferred.add(candidate.id);
    }
    return attempts;
  }
}
