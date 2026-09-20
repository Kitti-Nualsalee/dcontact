import { randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  CG5_CONTRACT_VERSION,
  CG5_EVENT_TYPES,
  assertCg5PiiFreePayload,
  type Cg5EvidenceLevel,
  type Cg5ExportDataset,
  type Cg5ExportState,
} from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';

const json = (value: unknown) => value as Prisma.InputJsonValue;

export class Cg5ExportIdempotencyConflictError extends Error {
  constructor() {
    super('idempotency key ถูกใช้กับ export คนละคำขอ');
    this.name = 'Cg5ExportIdempotencyConflictError';
  }
}

export class Cg5ExportTransitionError extends Error {
  constructor(
    readonly state: Cg5ExportState,
    readonly target: Cg5ExportState,
  ) {
    super(`export transition ${state} -> ${target} ไม่ถูกต้อง`);
    this.name = 'Cg5ExportTransitionError';
  }
}

const allowed: Readonly<Record<Cg5ExportState, readonly Cg5ExportState[]>> = {
  QUEUED: ['RUNNING', 'REVOKED'],
  RUNNING: ['READY', 'FAILED', 'REVOKED'],
  READY: ['EXPIRED', 'REVOKED'],
  FAILED: [],
  EXPIRED: [],
  REVOKED: [],
};

export class Cg5ExportJobRepository {
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async request(input: {
    tenantId: string;
    datasets: readonly Cg5ExportDataset[];
    rangeFrom: Date;
    rangeTo: Date;
    filters: Record<string, unknown>;
    evidenceLevel: Cg5EvidenceLevel;
    reason: string;
    requestedByRef: string;
    idempotencyKey: string;
  }) {
    if (!input.datasets.length || input.rangeFrom >= input.rangeTo)
      throw new TypeError('export range หรือ dataset ไม่ถูกต้อง');
    if (!input.reason.trim() || !input.requestedByRef.trim() || !input.idempotencyKey.trim())
      throw new TypeError('reason, requester และ idempotency key ต้องไม่ว่าง');
    assertCg5PiiFreePayload({
      datasets: input.datasets,
      filters: input.filters,
      reason: input.reason,
    });
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (tx) => {
      const existing = await tx.cg5ExportJob.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: input.tenantId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      const requestDigest = stableDigest({
        datasets: [...input.datasets].sort(),
        rangeFrom: input.rangeFrom.toISOString(),
        rangeTo: input.rangeTo.toISOString(),
        filters: input.filters,
        evidenceLevel: input.evidenceLevel,
        reason: input.reason,
      });
      if (existing) {
        const existingDigest = stableDigest({
          datasets: [...existing.datasets].sort(),
          rangeFrom: existing.rangeFrom.toISOString(),
          rangeTo: existing.rangeTo.toISOString(),
          filters: existing.filters,
          evidenceLevel: existing.evidenceLevel,
          reason: existing.reason,
        });
        if (existingDigest !== requestDigest) throw new Cg5ExportIdempotencyConflictError();
        return existing;
      }
      const now = this.now();
      const job = await tx.cg5ExportJob.create({
        data: {
          tenantId: input.tenantId,
          datasets: [...input.datasets],
          rangeFrom: input.rangeFrom,
          rangeTo: input.rangeTo,
          filters: json(input.filters),
          evidenceLevel: input.evidenceLevel,
          reason: input.reason,
          requestedByRef: input.requestedByRef,
          idempotencyKey: input.idempotencyKey,
          state: 'QUEUED',
          version: 1,
          updatedAt: now,
        },
      });
      await this.auditAndPublish(
        tx,
        input.tenantId,
        job.exportId,
        1,
        'QUEUED',
        input.requestedByRef,
        requestDigest,
        now,
      );
      return job;
    });
  }

  async transition(input: {
    tenantId: string;
    exportId: string;
    target: Cg5ExportState;
    actorRef: string;
    storagePrefix?: string;
    manifestDigest?: string;
    rowCounts?: Record<string, number>;
    expiresAt?: Date;
  }) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (tx) => {
      const current = await tx.cg5ExportJob.findFirst({
        where: { tenantId: input.tenantId, exportId: input.exportId },
      });
      if (!current) throw new TypeError('ไม่พบ export job');
      if (!allowed[current.state].includes(input.target))
        throw new Cg5ExportTransitionError(current.state, input.target);
      const now = this.now();
      const version = current.version + 1;
      const digest = stableDigest({
        exportId: current.exportId,
        state: input.target,
        version,
        manifestDigest: input.manifestDigest ?? null,
        rowCounts: input.rowCounts ?? null,
      });
      const job = await tx.cg5ExportJob.update({
        where: { exportId: current.exportId },
        data: {
          state: input.target,
          version,
          updatedAt: now,
          ...(input.storagePrefix ? { storagePrefix: input.storagePrefix } : {}),
          ...(input.manifestDigest ? { manifestDigest: input.manifestDigest } : {}),
          ...(input.rowCounts ? { rowCounts: json(input.rowCounts) } : {}),
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        },
      });
      await this.auditAndPublish(
        tx,
        input.tenantId,
        job.exportId,
        version,
        input.target,
        input.actorRef,
        digest,
        now,
      );
      return job;
    });
  }

  private async auditAndPublish(
    tx: Prisma.TransactionClient,
    tenantId: string,
    exportId: string,
    version: number,
    state: Cg5ExportState,
    actorRef: string,
    digest: string,
    now: Date,
  ) {
    const mutationId = randomUUID();
    const payload = {
      contractVersion: CG5_CONTRACT_VERSION,
      mutationId,
      subjectId: exportId,
      subjectVersion: version,
      effectiveAt: now.toISOString(),
      state,
      datasets: [],
      evidenceLevel: 'SUMMARY' as const,
    };
    assertCg5PiiFreePayload(payload);
    await tx.cgAuditLog.create({
      data: {
        tenantId,
        mutationId,
        aggregateType: 'EXPORT',
        aggregateId: exportId,
        aggregateVersion: version,
        action: `CG5_EXPORT_${state}`,
        actorClass: 'COMPLIANCE',
        actorRef,
        sourceKind: 'COMPLIANCE',
        evidenceRef: `cg5-export:${exportId}`,
        afterDigest: digest,
        occurredAt: now,
      },
    });
    await tx.cgEventOutbox.create({
      data: {
        mutationId,
        tenantId,
        aggregateType: 'EXPORT',
        aggregateId: exportId,
        aggregateVersion: version,
        eventType: CG5_EVENT_TYPES.EXPORT_CHANGED,
        orderingKey: `${tenantId}:${exportId}`,
        payload: json(payload),
        payloadHash: stableDigest(payload),
      },
    });
  }
}
