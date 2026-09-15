/**
 * J3.6 (#217) — durable ingest/apply ของ canonical `customer.segment.changed`
 *
 * ยึด identity สองชั้นแบบเดียวกับ J2.3: transport `(tenantId, source, eventId)` แยกจาก logical
 * `(tenantId, contactId, segmentId, membershipRevision)` — broker ส่ง event เดิมซ้ำชนทางแรก
 * ส่วน revision เดิมที่มาคนละ event ชนทางที่สอง ทั้งคู่ต้องไม่สร้าง receipt ใบที่สอง
 *
 * ที่นี่ไม่ตัดสินสิทธิ์และไม่อ่าน Customer 360 เอง — caller (trigger processor) เป็นคนเรียก
 * `CustomerSegmentMembershipReader.resolveEntry` และ `TeamContactScopeAuthorizer` แล้วส่งผลที่
 * ได้เข้ามา repository นี้รับผิดชอบเฉพาะการเขียนให้ atomic และรักษา invariant ของ stream
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type JrSegmentReceipt,
  type JrSegmentReceiptState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';

export interface IngestSegmentReceiptInput {
  tenantId: string;
  source: string;
  eventId: string;
  contactId: string;
  segmentId: string;
  membershipRevision: number;
  changeKind: string;
  entryId?: string;
  supersedesRevision?: number;
  segmentDefinitionVersion: number;
  payloadHash: string;
  evidenceRef?: string;
  correlationId: string;
  causationId?: string;
}

export type IngestSegmentReceiptOutcome =
  'DUPLICATE' | 'READY' | 'WAITING_FOR_GAP' | 'IGNORED_SUPERSEDED' | 'QUARANTINED';

export interface IngestSegmentReceiptResult {
  outcome: IngestSegmentReceiptOutcome;
  receipt: JrSegmentReceipt;
}

export class SegmentReceiptHashConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(
    readonly identity: string,
    readonly kind: 'TRANSPORT' | 'LOGICAL',
  ) {
    super(`Segment receipt hash ขัดแย้งกับของเดิม (${kind}): ${identity}`);
    this.name = 'SegmentReceiptHashConflictError';
  }
}

/**
 * entry ที่จบไปแล้วห้ามถูกชุบชีวิตกลับมาเป็น enrollment ใหม่
 *
 * ถ้าปล่อยผ่าน การส่ง event ย้อนหลังหรือ replay จะทำให้ contact ถูก enroll ซ้ำเข้า journey
 * ด้วยเหตุผลที่หมดอายุไปแล้ว — การเข้า segment รอบใหม่ต้องมากับ entryId ใหม่เท่านั้น
 */
export class SegmentEntryTerminalError extends Error {
  readonly code = 'INVALID_MEMBERSHIP_TRANSITION' as const;

  constructor(readonly entryId: string) {
    super(`entry ${entryId} ถูกปิดไปแล้ว สร้าง enrollment ใหม่จาก entry เดิมไม่ได้`);
    this.name = 'SegmentEntryTerminalError';
  }
}

/** enrollment intent หนึ่งใบต่อ (journey, version) — reason เก็บได้แค่ ref/version/digest */
export interface SegmentEnrollmentIntentInput {
  journeyId: string;
  journeyVersion: number;
  reasonMembershipRevision: number;
  reasonDefinitionVersion: number;
  reasonEvidenceRef?: string;
  reasonDigest: string;
}

export interface ApplySegmentEnrollmentInput {
  tenantId: string;
  receiptId: string;
  /** entryId ที่ resolveEntry ยืนยันว่า ELIGIBLE — ไม่ใช่ค่าที่ caller ส่งมาเอง */
  entryId: string;
  /** survivor ที่ Customer 360 ตัดสิน; ต่างจาก contactId บน receipt เมื่อมีการ merge */
  canonicalContactId: string;
  intents: readonly SegmentEnrollmentIntentInput[];
  correlationId: string;
  causationId?: string;
}

export interface ApplySegmentRefilterInput {
  tenantId: string;
  receiptId: string;
  reasonCode: string;
  /** ปิด entry นี้ถาวร (LEFT/invalidation) — ครั้งแรกเท่านั้นที่ได้ผล */
  terminalEntryId?: string;
  correlationId: string;
}

export interface SegmentOutboxEventInput {
  eventType: string;
  orderingKey: string;
  payload: Record<string, unknown>;
  payloadHash: string;
}

function streamLockKey(tenantId: string, contactId: string, segmentId: string): string {
  return `jr-segment-stream:${tenantId}:${contactId}:${segmentId}`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class JourneySegmentReceiptRepository {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    options: { id?: () => string; now?: () => Date } = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * ตัดสิน DUPLICATE/READY/WAITING_FOR_GAP/IGNORED_SUPERSEDED/QUARANTINED จาก
   * membershipRevision เทียบกับ head — ไม่เคย apply แบบ last-write-wins
   */
  async ingest(input: IngestSegmentReceiptInput): Promise<IngestSegmentReceiptResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const existingByTransport = await transaction.jrSegmentReceipt.findUnique({
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
          throw new SegmentReceiptHashConflictError(
            `${input.source}:${input.eventId}`,
            'TRANSPORT',
          );
        }
        return { outcome: 'DUPLICATE' as const, receipt: existingByTransport };
      }

      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(input.tenantId, input.contactId, input.segmentId)}))`,
      );

      const head = await transaction.jrSegmentHead.findUnique({
        where: {
          tenantId_contactId_segmentId: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            segmentId: input.segmentId,
          },
        },
      });
      const lastAppliedRevision = head?.lastAppliedRevision ?? 0;

      const state: JrSegmentReceiptState =
        input.membershipRevision <= lastAppliedRevision
          ? 'IGNORED_SUPERSEDED'
          : input.membershipRevision === lastAppliedRevision + 1
            ? 'READY'
            : 'WAITING_FOR_GAP';

      // savepoint กันไม่ให้ P2002 ของ insert นี้ทำทั้ง transaction abort — Postgres ปฏิเสธ
      // ทุก statement ถัดไปจนกว่าจะ rollback ถ้าไม่มี savepoint แยกไว้ก่อน
      await transaction.$executeRaw`SAVEPOINT segment_ingest`;
      try {
        const created = await transaction.jrSegmentReceipt.create({
          data: {
            id: this.id(),
            tenantId: input.tenantId,
            source: input.source,
            eventId: input.eventId,
            contactId: input.contactId,
            segmentId: input.segmentId,
            membershipRevision: input.membershipRevision,
            changeKind: input.changeKind,
            segmentDefinitionVersion: input.segmentDefinitionVersion,
            payloadHash: input.payloadHash,
            state,
            correlationId: input.correlationId,
            ...(input.entryId ? { entryId: input.entryId } : {}),
            ...(input.supersedesRevision !== undefined
              ? { supersedesRevision: input.supersedesRevision }
              : {}),
            ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
            ...(input.causationId ? { causationId: input.causationId } : {}),
          },
        });
        await transaction.$executeRaw`RELEASE SAVEPOINT segment_ingest`;
        return { outcome: state as IngestSegmentReceiptOutcome, receipt: created };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT segment_ingest`;
        // race: worker อีกตัวแทรก revision เดียวกันสำเร็จก่อน — อ่านของจริงแล้วตัดสินใหม่
        const raced = await transaction.jrSegmentReceipt.findUniqueOrThrow({
          where: {
            tenantId_contactId_segmentId_membershipRevision: {
              tenantId: input.tenantId,
              contactId: input.contactId,
              segmentId: input.segmentId,
              membershipRevision: input.membershipRevision,
            },
          },
        });
        if (raced.payloadHash !== input.payloadHash) {
          const quarantined = await transaction.jrSegmentReceipt.update({
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
   * เคลม receipt ที่พร้อมประมวลผลหนึ่งใบด้วย lease/CAS
   *
   * รวม PROCESSING ที่ lease หมดอายุกลับเข้าคิวด้วย — worker ที่ตายกลางทางต้องไม่ทำให้ receipt
   * ค้างตลอดกาล และเพราะ apply ทั้งก้อนเป็น transaction เดียว การ claim ซ้ำจึงไม่ apply ซ้ำ
   */
  async claimNextReady(
    tenantId: string,
    workerId: string,
    leaseSeconds = 30,
  ): Promise<JrSegmentReceipt | undefined> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM jr_segment_receipts
        WHERE tenant_id = ${tenantId}::uuid
          AND (
            (state = 'READY' AND available_at <= ${now})
            OR (state = 'PROCESSING' AND lease_expires_at <= ${now})
          )
        ORDER BY available_at, membership_revision
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const candidate = candidates[0];
      if (!candidate) return undefined;
      return transaction.jrSegmentReceipt.update({
        where: { id: candidate.id },
        data: { state: 'PROCESSING', leaseOwner: workerId, leaseExpiresAt },
      });
    });
  }

  /**
   * commit receipt + head + enrollment intent + outbox ในทรานแซกชันเดียว
   *
   * ทั้งสี่อย่างต้องไปด้วยกันเสมอ: intent ที่ไม่มี receipt คือ enrollment ที่ไม่มีเหตุผล
   * ส่วน outbox ที่ไม่มี intent คือการประกาศสิ่งที่ไม่เคยเกิดขึ้น
   */
  async applyEnrollment(
    input: ApplySegmentEnrollmentInput,
    event: SegmentOutboxEventInput,
  ): Promise<JrSegmentReceipt> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const receipt = await transaction.jrSegmentReceipt.findUniqueOrThrow({
        where: { id: input.receiptId },
      });
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(input.tenantId, receipt.contactId, receipt.segmentId)}))`,
      );

      const head = await this.advanceHead(transaction, receipt);
      if (head.terminalEntryId === input.entryId) {
        throw new SegmentEntryTerminalError(input.entryId);
      }

      for (const intent of input.intents) {
        // unique (tenant, journey, version, contact, segment, entry) ทำให้ entry เดียวได้
        // อย่างมากหนึ่ง enrollment ต่อ journey version แม้มี consumer หลายตัวยิงพร้อมกัน
        await transaction.$executeRaw`SAVEPOINT segment_intent`;
        try {
          await transaction.jrSegmentEnrollmentIntent.create({
            data: {
              id: this.id(),
              tenantId: input.tenantId,
              journeyId: intent.journeyId,
              journeyVersion: intent.journeyVersion,
              contactId: input.canonicalContactId,
              segmentId: receipt.segmentId,
              entryId: input.entryId,
              receiptId: receipt.id,
              reasonMembershipRevision: intent.reasonMembershipRevision,
              reasonDefinitionVersion: intent.reasonDefinitionVersion,
              reasonDigest: intent.reasonDigest,
              correlationId: input.correlationId,
              ...(intent.reasonEvidenceRef ? { reasonEvidenceRef: intent.reasonEvidenceRef } : {}),
            },
          });
          await transaction.$executeRaw`RELEASE SAVEPOINT segment_intent`;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // intent ใบเดิมมีอยู่แล้ว = replay ที่ถูกต้อง ไม่ใช่ความผิดพลาด
          await transaction.$executeRaw`ROLLBACK TO SAVEPOINT segment_intent`;
        }
      }

      await this.enqueue(transaction, receipt, event, input.correlationId, input.causationId);
      return this.markApplied(transaction, receipt.id);
    });
  }

  /**
   * commit receipt + head + re-filter cursor + outbox ในทรานแซกชันเดียว
   *
   * ใช้กับ change ที่ไม่ได้พา enrollment ใหม่เข้ามา (LEFT, correction, invalidation) — งานจริง
   * ของการประเมินใหม่เป็นของ J3.7 ที่นี่แค่บันทึกว่ามีอะไรรอประเมินอยู่
   */
  async applyRefilter(
    input: ApplySegmentRefilterInput,
    event: SegmentOutboxEventInput,
  ): Promise<JrSegmentReceipt> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const receipt = await transaction.jrSegmentReceipt.findUniqueOrThrow({
        where: { id: input.receiptId },
      });
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(input.tenantId, receipt.contactId, receipt.segmentId)}))`,
      );

      const head = await this.advanceHead(transaction, receipt);

      /**
       * first-terminal protection: entry ปิดได้ครั้งเดียว
       *
       * ถ้าปล่อยให้เขียนทับ เหตุผลและ revision ที่ปิด entry จะเปลี่ยนไปตาม event ใบล่าสุดที่
       * บังเอิญมาถึง ซึ่งทำให้ audit ตอบไม่ได้ว่าจริง ๆ แล้วอะไรเป็นตัวปิด entry นั้น
       */
      if (input.terminalEntryId && head.terminalEntryId === null) {
        await transaction.jrSegmentHead.update({
          where: {
            tenantId_contactId_segmentId: {
              tenantId: input.tenantId,
              contactId: receipt.contactId,
              segmentId: receipt.segmentId,
            },
          },
          data: {
            terminalEntryId: input.terminalEntryId,
            terminalRevision: receipt.membershipRevision,
            terminalReasonCode: input.reasonCode,
          },
        });
      }

      await transaction.$executeRaw`SAVEPOINT segment_cursor`;
      try {
        await transaction.jrSegmentRefilterCursor.create({
          data: {
            id: this.id(),
            tenantId: input.tenantId,
            contactId: receipt.contactId,
            segmentId: receipt.segmentId,
            membershipRevision: receipt.membershipRevision,
            receiptId: receipt.id,
            reasonCode: input.reasonCode,
            correlationId: input.correlationId,
          },
        });
        await transaction.$executeRaw`RELEASE SAVEPOINT segment_cursor`;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT segment_cursor`;
      }

      await this.enqueue(transaction, receipt, event, input.correlationId);
      return this.markApplied(transaction, receipt.id);
    });
  }

  async markReview(
    tenantId: string,
    receiptId: string,
    reasonCode: string,
  ): Promise<JrSegmentReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrSegmentReceipt.update({
        where: { id: receiptId },
        data: {
          state: 'REVIEW',
          reviewReasonCode: reasonCode,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  async markQuarantined(
    tenantId: string,
    receiptId: string,
    reasonCode: string,
  ): Promise<JrSegmentReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrSegmentReceipt.update({
        where: { id: receiptId },
        data: {
          state: 'QUARANTINED',
          reviewReasonCode: reasonCode,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  /**
   * ปล่อย lease แล้วเลื่อนเวลาให้ลองใหม่ — ใช้กับสาเหตุชั่วคราวเท่านั้น (STALE/unavailable)
   * ไม่ใช่กับ payload ที่เสียถาวร ซึ่งต้องไป QUARANTINED
   */
  async markRetryableFailure(
    tenantId: string,
    receiptId: string,
    backoffMs: number,
    reason: string,
  ): Promise<JrSegmentReceipt> {
    const availableAt = new Date(this.now().getTime() + backoffMs);
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrSegmentReceipt.update({
        where: { id: receiptId },
        data: {
          state: 'READY',
          attempts: { increment: 1 },
          availableAt,
          lastError: reason.slice(0, 1_000),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  private async advanceHead(transaction: Prisma.TransactionClient, receipt: JrSegmentReceipt) {
    const key = {
      tenantId_contactId_segmentId: {
        tenantId: receipt.tenantId,
        contactId: receipt.contactId,
        segmentId: receipt.segmentId,
      },
    };
    const head = await transaction.jrSegmentHead.findUnique({ where: key });
    if (!head) {
      const created = await transaction.jrSegmentHead.create({
        data: {
          tenantId: receipt.tenantId,
          contactId: receipt.contactId,
          segmentId: receipt.segmentId,
          lastAppliedRevision: receipt.membershipRevision,
          lastAppliedReceiptId: receipt.id,
        },
      });
      await this.promoteWaiting(transaction, receipt, receipt.membershipRevision);
      return created;
    }
    if (head.lastAppliedRevision >= receipt.membershipRevision) return head;
    const updated = await transaction.jrSegmentHead.update({
      where: key,
      data: {
        lastAppliedRevision: receipt.membershipRevision,
        lastAppliedReceiptId: receipt.id,
      },
    });
    await this.promoteWaiting(transaction, receipt, receipt.membershipRevision);
    return updated;
  }

  /**
   * head เลื่อนแล้ว: WAITING_FOR_GAP ของ stream นี้อาจพร้อม apply ต่อเพราะ gap ถูกเติมแล้ว
   * หรือกลายเป็นของเก่าที่ไม่ต้อง apply อีก — ไม่งั้นจะค้างรออยู่ตลอดไป
   */
  private async promoteWaiting(
    transaction: Prisma.TransactionClient,
    receipt: JrSegmentReceipt,
    lastAppliedRevision: number,
  ): Promise<void> {
    const waiting = await transaction.jrSegmentReceipt.findMany({
      where: {
        tenantId: receipt.tenantId,
        contactId: receipt.contactId,
        segmentId: receipt.segmentId,
        state: 'WAITING_FOR_GAP',
      },
      orderBy: { membershipRevision: 'asc' },
    });
    for (const pending of waiting) {
      if (pending.membershipRevision <= lastAppliedRevision) {
        await transaction.jrSegmentReceipt.update({
          where: { id: pending.id },
          data: { state: 'IGNORED_SUPERSEDED' },
        });
      } else if (pending.membershipRevision === lastAppliedRevision + 1) {
        await transaction.jrSegmentReceipt.update({
          where: { id: pending.id },
          data: { state: 'READY' },
        });
      }
    }
  }

  private async enqueue(
    transaction: Prisma.TransactionClient,
    receipt: JrSegmentReceipt,
    event: SegmentOutboxEventInput,
    correlationId: string,
    causationId?: string,
  ): Promise<void> {
    await transaction.$executeRaw`SAVEPOINT segment_outbox`;
    try {
      await transaction.jrSegmentOutbox.create({
        data: {
          id: this.id(),
          tenantId: receipt.tenantId,
          receiptId: receipt.id,
          eventId: this.id(),
          eventType: event.eventType,
          orderingKey: event.orderingKey,
          payloadHash: event.payloadHash,
          payload: event.payload as Prisma.InputJsonValue,
          correlationId,
          ...(causationId ? { causationId } : {}),
        },
      });
      await transaction.$executeRaw`RELEASE SAVEPOINT segment_outbox`;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await transaction.$executeRaw`ROLLBACK TO SAVEPOINT segment_outbox`;
    }
  }

  private markApplied(
    transaction: Prisma.TransactionClient,
    receiptId: string,
  ): Promise<JrSegmentReceipt> {
    return transaction.jrSegmentReceipt.update({
      where: { id: receiptId },
      data: {
        state: 'APPLIED',
        appliedAt: this.now(),
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
  }
}
