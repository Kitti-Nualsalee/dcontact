import { randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  DatabaseTenantPeopleReadiness,
  type TenantPeopleIdentityReadiness,
} from './tenant-people-readiness.js';
import { runPeopleWorkerStep, type TenantPeopleIdentityPort } from './tenant-people-worker.js';
import { voiceUuid } from './tenant-voice-catalog.js';
import { runNextPeopleInvitationReconcile } from './tenant-people-invitation-reconcile.js';
import { runPeopleInvitationPreparation } from './tenant-people-invitation-preparation.js';
import { runPeopleInvitationResend } from './tenant-people-invitation-sender.js';
import {
  runPeopleInvitationAttempt,
  type TenantPeopleInvitationRuntimePort,
  type TenantPeopleInvitationResendRuntimePort,
} from './tenant-people-invitation-worker.js';
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
  private readonly invitations: ReadonlyMap<string, TenantPeopleInvitationRuntimePort>;
  private readonly invitationCursors = new Map<string, string>();
  private readonly invitationTurns = new Map<string, boolean>();
  private readonly reconcileTurns = new Map<string, boolean>();
  private readonly resends: ReadonlyMap<string, TenantPeopleInvitationResendRuntimePort>;
  private readonly resendTurns = new Map<string, boolean>();
  private readonly resendCursors = new Map<string, string>();

  constructor(
    private readonly database: PrismaClient,
    private readonly identities: ReadonlyMap<string, TenantPeopleWorkerIdentity>,
    options: {
      intervalMs?: number;
      batchSize?: number;
      nodes?: ReadonlyMap<string, readonly PeopleTelephonyNode[]>;
      invitations?: ReadonlyMap<string, TenantPeopleInvitationRuntimePort>;
      resends?: ReadonlyMap<string, TenantPeopleInvitationResendRuntimePort>;
    } = {},
  ) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.batchSize = options.batchSize ?? 20;
    this.nodes = options.nodes ?? new Map();
    this.invitations = new Map(options.invitations);
    this.resends = new Map(options.resends);
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
    for (const [tenantId, port] of this.invitations) {
      if (
        !identities.has(tenantId) ||
        !port ||
        typeof port.isReady !== 'function' ||
        typeof port.dispatch !== 'function' ||
        typeof port.readOutcome !== 'function'
      )
        throw new Error('INVALID_PEOPLE_INVITATION_RUNTIME_CONFIGURATION');
    }
    this.readiness = new DatabaseTenantPeopleReadiness(database, identities);
    for (const [tenantId, port] of this.resends) {
      if (
        !identities.has(tenantId) ||
        !port ||
        typeof port.isReady !== 'function' ||
        typeof port.prepare !== 'function' ||
        typeof port.readPreparation !== 'function' ||
        typeof port.dispatchPrepared !== 'function' ||
        typeof port.readOutcome !== 'function'
      )
        throw new Error('INVALID_PEOPLE_RESEND_RUNTIME_CONFIGURATION');
    }
  }

  async isReady(tenantId: string): Promise<boolean> {
    if (!this.running || !this.healthy) return false;
    const ready = await this.readiness.isReady(tenantId);
    return ready && this.running && this.healthy;
  }

  nodesForTenant(tenantId: string): readonly PeopleTelephonyNode[] {
    return this.nodes.get(tenantId) ?? [];
  }

  async canReconcileInvitation(tenantId: string): Promise<boolean> {
    const port = this.invitations.get(tenantId);
    return (
      !!port && (await this.isReady(tenantId)) && (await port.isReady(tenantId)) && this.running
    );
  }

  async canResendInvitation(tenantId: string): Promise<boolean> {
    const port = this.resends.get(tenantId);
    return (
      !!port &&
      (await this.isReady(tenantId)) &&
      (await port.isReady(tenantId)) &&
      this.running &&
      this.healthy
    );
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
    const invitationChecked = new Map<string, boolean>();
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
      const invitationFirst =
        (this.invitations.has(tenantId) || this.resends.has(tenantId)) &&
        (this.invitationTurns.get(tenantId) ?? true);
      if (this.invitations.has(tenantId) || this.resends.has(tenantId))
        this.invitationTurns.set(tenantId, !invitationFirst);
      if (invitationFirst && (await this.tryInvitation(tenantId, deferred, invitationChecked))) {
        attempts++;
        idle = 0;
        continue;
      }
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
        if (!invitationFirst && (await this.tryInvitation(tenantId, deferred, invitationChecked))) {
          attempts++;
          idle = 0;
          continue;
        }
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

  private async tryInvitation(
    tenantId: string,
    deferred: Set<string>,
    checked: Map<string, boolean>,
  ): Promise<boolean> {
    const resendFirst = this.resends.has(tenantId) && (this.resendTurns.get(tenantId) ?? true);
    if (this.resends.has(tenantId)) this.resendTurns.set(tenantId, !resendFirst);
    if (resendFirst && (await this.tryResend(tenantId, deferred, checked))) return true;
    if (await this.tryDelivery(tenantId, deferred, checked)) return true;
    return !resendFirst && (await this.tryResend(tenantId, deferred, checked));
  }

  private async tryResend(
    tenantId: string,
    deferred: Set<string>,
    checked: Map<string, boolean>,
  ): Promise<boolean> {
    const port = this.resends.get(tenantId);
    if (!this.running || !port) return false;
    const readinessKey = `resend:${tenantId}`;
    if (!checked.has(readinessKey)) checked.set(readinessKey, await port.isReady(tenantId));
    if (!this.running || !checked.get(readinessKey)) return false;
    const cursor = this.resendCursors.get(tenantId) ?? '00000000-0000-0000-0000-000000000000';
    const candidate = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      async (transaction) => {
        const rows = await transaction.$queryRaw<{ id: string; prepared: boolean }[]>`
        SELECT r.id,proof.provider_attempt_ref IS NOT NULL AS prepared FROM tenant_people_invitation_resends r
        LEFT JOIN tenant_people_invitation_preparations p ON p.tenant_id=r.tenant_id AND p.resend_id=r.id
        LEFT JOIN tenant_people_invitation_preparation_proofs proof ON proof.tenant_id=p.tenant_id AND proof.provider_attempt_ref=p.provider_attempt_ref
        WHERE r.tenant_id=${tenantId}::uuid
          AND NOT EXISTS(SELECT 1 FROM tenant_people_invitation_receipts receipt WHERE receipt.tenant_id=r.tenant_id AND receipt.provider_attempt_ref=r.provider_attempt_ref)
          AND ('resend:' || r.tenant_id::text || ':' || r.id::text) NOT IN(SELECT value FROM jsonb_array_elements_text(${JSON.stringify([...deferred])}::jsonb) AS skipped(value))
        ORDER BY (r.id>${cursor}::uuid) DESC,r.id LIMIT 1`;
        return rows[0];
      },
    );
    if (!this.running || !candidate) return false;
    this.resendCursors.set(tenantId, candidate.id);
    deferred.add(`resend:${tenantId}:${candidate.id}`);
    if (candidate.prepared)
      await runPeopleInvitationResend(this.database, port, tenantId, candidate.id);
    else await runPeopleInvitationPreparation(this.database, port, tenantId, candidate.id);
    return true;
  }

  private async tryDelivery(
    tenantId: string,
    deferred: Set<string>,
    checked: Map<string, boolean>,
  ): Promise<boolean> {
    const port = this.invitations.get(tenantId);
    if (!this.running || !port) return false;
    if (!checked.has(tenantId)) checked.set(tenantId, await port.isReady(tenantId));
    if (!this.running || !checked.get(tenantId)) return false;
    const reconcileFirst = this.reconcileTurns.get(tenantId) ?? true;
    this.reconcileTurns.set(tenantId, !reconcileFirst);
    if (reconcileFirst && (await runNextPeopleInvitationReconcile(this.database, port, tenantId)))
      return true;
    const cursor = this.invitationCursors.get(tenantId) ?? '00000000-0000-0000-0000-000000000000';
    const candidate = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      async (transaction) => {
        const rows = await transaction.$queryRaw<
          { operationId: string; generation: number; providerAttemptRef: string }[]
        >`
        SELECT i.operation_id AS "operationId",i.generation,i.provider_attempt_ref AS "providerAttemptRef" FROM tenant_people_invitation_intents i
        JOIN tenant_people_operations o ON o.tenant_id=i.tenant_id AND o.id=i.operation_id AND o.target_user_id=i.user_id
        JOIN tenant_user_lifecycles l ON l.tenant_id=i.tenant_id AND l.user_id=i.user_id AND l.operation_id=i.operation_id
        WHERE i.tenant_id=${tenantId}::uuid AND i.generation=1 AND o.state='SUCCEEDED'
          AND l.account_state='PENDING_ACTIVATION' AND l.provisioning_state='PROVISIONED' AND l.activation_state='PENDING'
          AND NOT EXISTS(SELECT 1 FROM tenant_people_invitation_receipts r WHERE r.tenant_id=i.tenant_id AND r.provider_attempt_ref=i.provider_attempt_ref)
          AND i.operation_id::text NOT IN (SELECT value FROM jsonb_array_elements_text(${JSON.stringify([...deferred])}::jsonb) AS skipped(value))
        ORDER BY (i.operation_id>${cursor}::uuid) DESC,i.operation_id LIMIT 1`;
        return rows[0];
      },
    );
    if (!this.running) return false;
    if (!candidate)
      return (
        !reconcileFirst && (await runNextPeopleInvitationReconcile(this.database, port, tenantId))
      );
    this.invitationCursors.set(tenantId, candidate.operationId);
    deferred.add(candidate.operationId);
    await runPeopleInvitationAttempt(
      this.database,
      port,
      tenantId,
      candidate.operationId,
      this.owner,
      { generation: candidate.generation, providerAttemptRef: candidate.providerAttemptRef },
    );
    return true;
  }
}
