/**
 * J3.8 (#219) — audited recovery ของ segment membership stream
 *
 * สามข้อที่บังคับทุก operation ในไฟล์นี้:
 *
 * 1. **ไม่รับ payload ทดแทน** — operator ส่งได้แค่ `targetRef` + `reasonCode` + `evidenceRef`
 *    ที่เหลือใช้ของเดิมที่ commit ไว้ทั้งหมด การให้แก้เนื้อหาตอน recovery เท่ากับเปิดทางให้
 *    ปลอม membership fact ผ่านช่องทาง forensic
 * 2. **`expectedVersion` ต้องตรง** — กัน blind retry ที่ทับ state ซึ่งขยับไปแล้วระหว่างที่
 *    operator กำลังดูหน้าจออยู่
 * 3. **audit ก่อนเสมอ** — บันทึก actor/reason/target ลง `jr_recovery_audit` ในทรานแซกชันเดียว
 *    กับการเปลี่ยน state ไม่ใช่เขียนทีหลังแบบ best-effort
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export class SegmentRecoveryNotFoundError extends Error {
  readonly code = 'RESOURCE_NOT_FOUND' as const;

  constructor(readonly targetRef: string) {
    super(`ไม่พบเป้าหมายของ recovery: ${targetRef}`);
    this.name = 'SegmentRecoveryNotFoundError';
  }
}

export class SegmentRecoveryVersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT' as const;

  constructor(
    readonly targetRef: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`version ของ ${targetRef} ขยับไปแล้ว: ${expectedVersion} -> ${actualVersion}`);
    this.name = 'SegmentRecoveryVersionConflictError';
  }
}

export class SegmentRecoveryNotAllowedError extends Error {
  readonly code = 'RECOVERY_NOT_ALLOWED' as const;

  constructor(
    readonly targetRef: string,
    readonly state: string,
  ) {
    super(`สถานะ ${state} ของ ${targetRef} ทำ recovery แบบนี้ไม่ได้`);
    this.name = 'SegmentRecoveryNotAllowedError';
  }
}

export interface SegmentRecoveryInput {
  tenantId: string;
  /** opaque reference เดิม — eventId ของ receipt หรือ id ของ cursor ไม่ใช่ค่าที่สร้างใหม่ */
  targetRef: string;
  expectedVersion: number;
  reasonCode: string;
  actorId: string;
  evidenceRef?: string;
}

export interface SegmentRecoveryResult {
  targetRef: string;
  state: string;
  version: number;
}

/**
 * REPLAY คืน receipt กลับเข้าคิวได้เฉพาะจากสถานะที่ค้างเพราะคนตัดสินใจ ไม่ใช่จากสถานะที่จบแล้ว
 *
 * APPLIED แปลว่า effect เกิดไปแล้ว การ replay จะสร้าง effect ซ้ำ ส่วน IGNORED_SUPERSEDED
 * แปลว่ามีของใหม่กว่ากลืนไปแล้ว การปลุกกลับมาคือการย้อน head ซึ่งห้ามเด็ดขาด
 */
const REPLAYABLE_RECEIPT_STATES = new Set(['REVIEW', 'QUARANTINED']);

/** ข้ามได้เฉพาะของที่ถูกกักไว้จริง ๆ — ข้ามของที่ยังไม่เคยลองคือการทิ้งงานเงียบ ๆ */
const SKIPPABLE_RECEIPT_STATES = new Set(['QUARANTINED', 'REVIEW']);

/** cursor ที่จบแล้ว (NO_OP/CANCELLED) ปลุกกลับมาไม่ได้ — stop condition ห้าม revive cancelled work */
const REVALIDATABLE_CURSOR_STATES = new Set([
  'PENDING',
  'REVALIDATING',
  'DEFERRED',
  'HELD',
  'RECONCILING',
]);

export class JourneySegmentRecovery {
  constructor(private readonly database: PrismaClient) {}

  /**
   * คืน receipt ที่ค้างอยู่กลับเข้าคิวด้วย identity เดิมทุกอย่าง
   *
   * ไม่แตะ eventId, membershipRevision, entryId หรือ payloadHash เลย — ที่เปลี่ยนคือ state
   * กับเวลาที่พร้อมทำงานเท่านั้น owner จึง dedupe ได้ตามเดิมและไม่มีทางเกิด fact ใหม่
   */
  async replayReceipt(input: SegmentRecoveryInput): Promise<SegmentRecoveryResult> {
    return this.mutateReceipt(input, 'REPLAY', REPLAYABLE_RECEIPT_STATES, {
      state: 'READY',
      availableAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /** ปิด receipt ที่เสียถาวรโดยยอมรับว่าจะไม่ถูกประมวลผล — ต้องมีเหตุผลติดไว้เสมอ */
  async skipQuarantine(input: SegmentRecoveryInput): Promise<SegmentRecoveryResult> {
    return this.mutateReceipt(input, 'SKIP_QUARANTINE', SKIPPABLE_RECEIPT_STATES, {
      state: 'IGNORED_SUPERSEDED',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /** สั่งงาน re-filter ให้ประเมินใหม่ทันทีแทนที่จะรอ backoff */
  async revalidateRefilter(input: SegmentRecoveryInput): Promise<SegmentRecoveryResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const cursor = await transaction.jrSegmentRefilterCursor.findFirst({
        where: { tenantId: input.tenantId, id: input.targetRef },
        select: { id: true, state: true, version: true },
      });
      if (!cursor) throw new SegmentRecoveryNotFoundError(input.targetRef);
      if (cursor.version !== input.expectedVersion) {
        throw new SegmentRecoveryVersionConflictError(
          input.targetRef,
          input.expectedVersion,
          cursor.version,
        );
      }
      if (!REVALIDATABLE_CURSOR_STATES.has(cursor.state)) {
        throw new SegmentRecoveryNotAllowedError(input.targetRef, cursor.state);
      }

      const updated = await transaction.jrSegmentRefilterCursor.update({
        where: { id: cursor.id },
        data: {
          state: 'PENDING',
          availableAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
        select: { state: true, version: true },
      });
      await this.audit(transaction, input, 'REVALIDATE', 'SEGMENT_REFILTER');
      return { targetRef: input.targetRef, state: updated.state, version: updated.version };
    });
  }

  private async mutateReceipt(
    input: SegmentRecoveryInput,
    operation: 'REPLAY' | 'SKIP_QUARANTINE',
    allowedStates: ReadonlySet<string>,
    data: Record<string, unknown>,
  ): Promise<SegmentRecoveryResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      /**
       * ค้นด้วย eventId ไม่ใช่ row id — operator เห็น eventId จาก forensic view และจาก log
       * ส่วน row id เป็นรายละเอียดภายในที่ไม่ควรต้องรู้เพื่อสั่ง recovery
       */
      const receipt = await transaction.jrSegmentReceipt.findFirst({
        where: { tenantId: input.tenantId, eventId: input.targetRef },
        select: { id: true, state: true, version: true },
      });
      if (!receipt) throw new SegmentRecoveryNotFoundError(input.targetRef);
      if (receipt.version !== input.expectedVersion) {
        throw new SegmentRecoveryVersionConflictError(
          input.targetRef,
          input.expectedVersion,
          receipt.version,
        );
      }
      if (!allowedStates.has(receipt.state)) {
        throw new SegmentRecoveryNotAllowedError(input.targetRef, receipt.state);
      }

      const updated = await transaction.jrSegmentReceipt.update({
        where: { id: receipt.id },
        data: { ...data, version: { increment: 1 } },
        select: { state: true, version: true },
      });
      await this.audit(transaction, input, operation, 'SEGMENT_RECEIPT');
      return { targetRef: input.targetRef, state: updated.state, version: updated.version };
    });
  }

  private async audit(
    transaction: Parameters<Parameters<typeof withTenantDatabaseTransaction>[2]>[0],
    input: SegmentRecoveryInput,
    operation: 'REPLAY' | 'SKIP_QUARANTINE' | 'REVALIDATE',
    targetKind: 'SEGMENT_RECEIPT' | 'SEGMENT_REFILTER',
  ): Promise<void> {
    await transaction.jrRecoveryAudit.create({
      data: {
        tenantId: input.tenantId,
        operation,
        targetKind,
        targetRef: input.targetRef,
        reasonCode: input.reasonCode,
        actorId: input.actorId,
        ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
      },
    });
  }
}
