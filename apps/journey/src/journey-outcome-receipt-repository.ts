/**
 * J2.3 — durable foundation ของ canonical interaction outcome receipt
 *
 * ยึด identity สองชั้นตามที่ยืนยันใน #123: transport completion unique
 * `(tenantId, source, eventId)` แยกจาก logical stream identity unique
 * `(tenantId, outcomeType, outcomeId, outcomeVersion)`. ที่นี่เป็นเพียง schema/
 * primitive — ไม่มี trigger matching, owner implementation หรือ relay transport
 * (ดู #131 ขอบเขต J2.3)
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type JrOutcomeReceipt,
  type JrOutcomeReceiptState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';

export interface IngestOutcomeReceiptInput {
  tenantId: string;
  source: string;
  eventId: string;
  outcomeType: string;
  outcomeId: string;
  outcomeVersion: number;
  payloadHash: string;
  correlationId: string;
  causationId?: string;
}

export type IngestOutcomeReceiptOutcome =
  'DUPLICATE' | 'READY' | 'WAITING_FOR_GAP' | 'IGNORED_SUPERSEDED' | 'QUARANTINED';

export interface IngestOutcomeReceiptResult {
  outcome: IngestOutcomeReceiptOutcome;
  receipt: JrOutcomeReceipt;
}

export class OutcomeReceiptHashConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(
    readonly identity: string,
    readonly kind: 'TRANSPORT' | 'LOGICAL',
  ) {
    super(`Outcome receipt hash ขัดแย้งกับของเดิม (${kind}): ${identity}`);
    this.name = 'OutcomeReceiptHashConflictError';
  }
}

function streamLockKey(tenantId: string, outcomeType: string, outcomeId: string): string {
  return `jr-outcome-stream:${tenantId}:${outcomeType}:${outcomeId}`;
}

export class JourneyOutcomeReceiptRepository {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: { id?: () => string } = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  /**
   * ตัดสิน DUPLICATE/READY/WAITING_FOR_GAP/IGNORED_SUPERSEDED/QUARANTINED ตาม
   * outcomeVersion เทียบกับ head ปัจจุบัน — ไม่เคย apply ด้วย last-write-wins
   */
  async ingest(input: IngestOutcomeReceiptInput): Promise<IngestOutcomeReceiptResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const existingByTransport = await transaction.jrOutcomeReceipt.findUnique({
        where: {
          tenantId_source_eventId: {
            tenantId: input.tenantId,
            source: input.source,
            eventId: input.eventId,
          },
        },
      });
      if (existingByTransport) {
        if (existingByTransport.payloadHash !== input.payloadHash) {
          throw new OutcomeReceiptHashConflictError(
            `${input.source}:${input.eventId}`,
            'TRANSPORT',
          );
        }
        return { outcome: 'DUPLICATE' as const, receipt: existingByTransport };
      }

      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(input.tenantId, input.outcomeType, input.outcomeId)}))`,
      );

      const head = await transaction.jrOutcomeHead.findUnique({
        where: {
          tenantId_outcomeType_outcomeId: {
            tenantId: input.tenantId,
            outcomeType: input.outcomeType,
            outcomeId: input.outcomeId,
          },
        },
      });
      const lastAppliedVersion = head?.lastAppliedVersion ?? 0;

      const state: JrOutcomeReceiptState =
        input.outcomeVersion <= lastAppliedVersion
          ? 'IGNORED_SUPERSEDED'
          : input.outcomeVersion === lastAppliedVersion + 1
            ? 'READY'
            : 'WAITING_FOR_GAP';

      // savepoint กันไม่ให้ P2002 ของ insert นี้ทำทั้ง transaction abort — Postgres
      // ปฏิเสธทุก statement ถัดไปจนกว่าจะ rollback ถ้าไม่มี savepoint แยกไว้ก่อน
      await transaction.$executeRaw`SAVEPOINT ingest_insert`;
      try {
        const created = await transaction.jrOutcomeReceipt.create({
          data: {
            id: this.id(),
            tenantId: input.tenantId,
            source: input.source,
            eventId: input.eventId,
            outcomeType: input.outcomeType,
            outcomeId: input.outcomeId,
            outcomeVersion: input.outcomeVersion,
            payloadHash: input.payloadHash,
            state,
            correlationId: input.correlationId,
            ...(input.causationId ? { causationId: input.causationId } : {}),
          },
        });
        await transaction.$executeRaw`RELEASE SAVEPOINT ingest_insert`;
        return { outcome: state as IngestOutcomeReceiptOutcome, receipt: created };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT ingest_insert`;
        // race: อีก worker แทรก version เดียวกันสำเร็จก่อน — อ่านของจริงแล้วตัดสินใหม่
        const raced = await transaction.jrOutcomeReceipt.findUniqueOrThrow({
          where: {
            tenantId_outcomeType_outcomeId_outcomeVersion: {
              tenantId: input.tenantId,
              outcomeType: input.outcomeType,
              outcomeId: input.outcomeId,
              outcomeVersion: input.outcomeVersion,
            },
          },
        });
        if (raced.payloadHash !== input.payloadHash) {
          const quarantined = await transaction.jrOutcomeReceipt.update({
            where: { id: raced.id },
            data: { state: 'QUARANTINED', reviewReasonCode: 'EVENT_HASH_CONFLICT' },
          });
          return { outcome: 'QUARANTINED' as const, receipt: quarantined };
        }
        return { outcome: 'DUPLICATE' as const, receipt: raced };
      }
    });
  }

  /**
   * เคลม receipt ที่พร้อมประมวลผลหนึ่งใบด้วย lease/CAS; รวม PROCESSING ที่ lease
   * หมดอายุแล้วกลับเข้าคิวให้ worker อื่น claim ต่อได้โดยไม่ apply ซ้ำ
   */
  async claimNextReady(
    tenantId: string,
    workerId: string,
    leaseSeconds = 30,
  ): Promise<JrOutcomeReceipt | undefined> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM jr_outcome_receipts
        WHERE tenant_id = ${tenantId}::uuid
          AND (
            (state = 'READY' AND available_at <= ${now})
            OR (state = 'PROCESSING' AND lease_expires_at <= ${now})
          )
        ORDER BY available_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const candidate = candidates[0];
      if (!candidate) return undefined;
      return transaction.jrOutcomeReceipt.update({
        where: { id: candidate.id },
        data: { state: 'PROCESSING', leaseOwner: workerId, leaseExpiresAt },
      });
    });
  }

  /**
   * apply สำเร็จ — ถือ advisory lock เดิมของ stream ก่อนเลื่อน head เพื่อกัน
   * markApplied ของ worker คนละตัวแข่งกันเลื่อน head พร้อมกัน; เลื่อนเฉพาะเมื่อ
   * version นี้ยังมากกว่า head ปัจจุบัน (CAS โดย read-then-write ภายใต้ lock เดียว)
   */
  async markApplied(tenantId: string, receiptId: string): Promise<JrOutcomeReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const receipt = await transaction.jrOutcomeReceipt.update({
        where: { id: receiptId },
        data: { state: 'APPLIED', appliedAt: new Date() },
      });
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(tenantId, receipt.outcomeType, receipt.outcomeId)}))`,
      );
      const headKey = {
        tenantId_outcomeType_outcomeId: {
          tenantId,
          outcomeType: receipt.outcomeType,
          outcomeId: receipt.outcomeId,
        },
      };
      const head = await transaction.jrOutcomeHead.findUnique({
        where: headKey,
        select: { lastAppliedVersion: true },
      });
      const advancedVersion = !head || head.lastAppliedVersion < receipt.outcomeVersion;
      if (!head) {
        await transaction.jrOutcomeHead.create({
          data: {
            tenantId,
            outcomeType: receipt.outcomeType,
            outcomeId: receipt.outcomeId,
            lastAppliedVersion: receipt.outcomeVersion,
            lastAppliedReceiptId: receipt.id,
          },
        });
      } else if (advancedVersion) {
        await transaction.jrOutcomeHead.update({
          where: headKey,
          data: { lastAppliedVersion: receipt.outcomeVersion, lastAppliedReceiptId: receipt.id },
        });
      }

      // head เลื่อนแล้ว: WAITING_FOR_GAP เดิมของ stream นี้อาจพร้อม apply ต่อ (gap
      // ถูกเติมแล้ว) หรือกลายเป็นของเก่าที่ไม่ต้อง apply อีก — ไม่งั้นจะค้างตลอดไป
      if (advancedVersion) {
        const lastAppliedVersion = receipt.outcomeVersion;
        const waiting = await transaction.jrOutcomeReceipt.findMany({
          where: {
            tenantId,
            outcomeType: receipt.outcomeType,
            outcomeId: receipt.outcomeId,
            state: 'WAITING_FOR_GAP',
          },
        });
        for (const pending of waiting) {
          if (pending.outcomeVersion <= lastAppliedVersion) {
            await transaction.jrOutcomeReceipt.update({
              where: { id: pending.id },
              data: { state: 'IGNORED_SUPERSEDED' },
            });
          } else if (pending.outcomeVersion === lastAppliedVersion + 1) {
            await transaction.jrOutcomeReceipt.update({
              where: { id: pending.id },
              data: { state: 'READY' },
            });
          }
        }
      }
      return receipt;
    });
  }

  async markReview(
    tenantId: string,
    receiptId: string,
    reasonCode: string,
  ): Promise<JrOutcomeReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOutcomeReceipt.update({
        where: { id: receiptId },
        data: { state: 'REVIEW', reviewReasonCode: reasonCode },
      }),
    );
  }

  async markQuarantined(
    tenantId: string,
    receiptId: string,
    reasonCode: string,
  ): Promise<JrOutcomeReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOutcomeReceipt.update({
        where: { id: receiptId },
        data: { state: 'QUARANTINED', reviewReasonCode: reasonCode },
      }),
    );
  }

  /** retryable failure กลับไป READY พร้อม bounded backoff — ไม่ persist เป็น state แยก */
  async markRetryableFailure(
    tenantId: string,
    receiptId: string,
    backoffMs: number,
    errorMessage: string,
  ): Promise<JrOutcomeReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOutcomeReceipt.update({
        where: { id: receiptId },
        data: {
          state: 'READY',
          attempts: { increment: 1 },
          availableAt: new Date(Date.now() + backoffMs),
          lastError: errorMessage.slice(0, 1_000),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  /** WAITING_FOR_GAP ที่ค้างเกิน timeout — ผู้เรียกตัดสินใจ reconcile/escalate เอง */
  findStaleGaps(tenantId: string, olderThan: Date): Promise<JrOutcomeReceipt[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOutcomeReceipt.findMany({
        where: { tenantId, state: 'WAITING_FOR_GAP', receivedAt: { lte: olderThan } },
        orderBy: { receivedAt: 'asc' },
      }),
    );
  }

  findByOutcome(
    tenantId: string,
    outcomeType: string,
    outcomeId: string,
  ): Promise<JrOutcomeReceipt[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOutcomeReceipt.findMany({
        where: { tenantId, outcomeType, outcomeId },
        orderBy: { outcomeVersion: 'asc' },
      }),
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
