/**
 * J3.10 (#221) — rollout stage ของ J3 ต่อ tenant และ shadow evaluation
 *
 * ลำดับ: DISABLED → OWNER_BACKFILL → SHADOW_MEMBERSHIP → SHADOW_RECEIPT_REFILTER →
 * SCOPED_INTERNAL_ENABLED
 *
 * สองอย่างที่แยกกันชัดเจนและมักถูกสับสน:
 *
 * - **stage เดินหน้าอย่างเดียว** ย้อนกลับเท่ากับปลุก writer ที่ถูกปลดไปแล้วให้กลับมาเขียนทับ
 *   ของใหม่ ซึ่งฐานข้อมูลปฏิเสธผ่าน `jr_segment_rollout_guard`
 * - **rollback คือ freeze** ไม่ใช่ย้อน stage — หยุด effect ใหม่โดยไม่แตะของที่เกิดไปแล้ว
 *   และย้อนกลับได้เมื่อแก้ปัญหาเสร็จ (stop condition ห้าม destructive down migration)
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export type SegmentRolloutStage =
  | 'DISABLED'
  | 'OWNER_BACKFILL'
  | 'SHADOW_MEMBERSHIP'
  | 'SHADOW_RECEIPT_REFILTER'
  | 'SCOPED_INTERNAL_ENABLED';

const STAGE_ORDER: readonly SegmentRolloutStage[] = [
  'DISABLED',
  'OWNER_BACKFILL',
  'SHADOW_MEMBERSHIP',
  'SHADOW_RECEIPT_REFILTER',
  'SCOPED_INTERNAL_ENABLED',
];

export class SegmentRolloutTransitionError extends Error {
  readonly code = 'INVALID_MEMBERSHIP_TRANSITION' as const;

  constructor(
    readonly from: SegmentRolloutStage,
    readonly to: SegmentRolloutStage,
  ) {
    super(`เปลี่ยน rollout stage จาก ${from} ไป ${to} ไม่ได้`);
    this.name = 'SegmentRolloutTransitionError';
  }
}

export class SegmentRolloutVersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT' as const;

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`rollout state ขยับไปแล้ว: ${expectedVersion} -> ${actualVersion}`);
    this.name = 'SegmentRolloutVersionConflictError';
  }
}

export interface SegmentRolloutView {
  stage: SegmentRolloutStage;
  mutationFrozen: boolean;
  version: number;
  shadowStartedAt: string | null;
  switchedAt: string | null;
}

export interface ShadowComparisonInput {
  tenantId: string;
  contactId: string;
  segmentId: string;
  membershipRevision: number;
  /** digest ที่ Customer 360 ประกาศมากับ event */
  expectedDigest: string;
  /** digest ที่ J3 คำนวณได้เองจาก receipt ที่เก็บไว้ */
  observedDigest: string;
}

export class JourneySegmentRollout {
  constructor(private readonly database: PrismaClient) {}

  /** ไม่มีแถว = ยังไม่เคยเปิด แปลว่า DISABLED */
  async read(tenantId: string): Promise<SegmentRolloutView> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const row = await transaction.jrSegmentRolloutState.findUnique({
        where: { tenantId },
        select: {
          stage: true,
          mutationFrozen: true,
          version: true,
          shadowStartedAt: true,
          switchedAt: true,
        },
      });
      if (!row) {
        return {
          stage: 'DISABLED' as const,
          mutationFrozen: false,
          version: 0,
          shadowStartedAt: null,
          switchedAt: null,
        };
      }
      return {
        stage: row.stage as SegmentRolloutStage,
        mutationFrozen: row.mutationFrozen,
        version: row.version,
        shadowStartedAt: row.shadowStartedAt?.toISOString() ?? null,
        switchedAt: row.switchedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * เลื่อน stage ไปข้างหน้าทีละขั้นเท่านั้น
   *
   * ห้ามข้ามขั้นเพราะแต่ละขั้นมีไว้เพื่อสังเกตผลก่อนเปิดขั้นถัดไป การกระโดดจาก OWNER_BACKFILL
   * ไป SCOPED_INTERNAL_ENABLED เลยแปลว่าไม่เคยมี shadow ให้ดูว่าระบบคำนวณตรงกับ Customer 360
   * ไหม ซึ่งทำให้ทั้งกระบวนการไม่มีความหมาย
   */
  async advance(input: {
    tenantId: string;
    to: SegmentRolloutStage;
    expectedVersion: number;
    updatedByRef: string;
    evidenceRef?: string;
  }): Promise<SegmentRolloutView> {
    const current = await this.read(input.tenantId);
    const fromRank = STAGE_ORDER.indexOf(current.stage);
    const toRank = STAGE_ORDER.indexOf(input.to);
    if (toRank !== fromRank + 1) {
      throw new SegmentRolloutTransitionError(current.stage, input.to);
    }
    if (current.version !== input.expectedVersion) {
      throw new SegmentRolloutVersionConflictError(input.expectedVersion, current.version);
    }

    const now = new Date();
    const entersShadow = input.to === 'SHADOW_MEMBERSHIP';
    const switches = input.to === 'SCOPED_INTERNAL_ENABLED';

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      if (current.version === 0) {
        const created = await transaction.jrSegmentRolloutState.create({
          data: {
            tenantId: input.tenantId,
            stage: input.to,
            updatedByRef: input.updatedByRef,
            ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
            ...(entersShadow ? { shadowStartedAt: now } : {}),
          },
          select: {
            stage: true,
            mutationFrozen: true,
            version: true,
            shadowStartedAt: true,
            switchedAt: true,
          },
        });
        return this.toView(created);
      }
      const updated = await transaction.jrSegmentRolloutState.update({
        where: { tenantId: input.tenantId },
        data: {
          stage: input.to,
          updatedByRef: input.updatedByRef,
          version: { increment: 1 },
          ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
          ...(entersShadow ? { shadowStartedAt: now } : {}),
          ...(switches ? { switchedAt: now } : {}),
        },
        select: {
          stage: true,
          mutationFrozen: true,
          version: true,
          shadowStartedAt: true,
          switchedAt: true,
        },
      });
      return this.toView(updated);
    });
  }

  /**
   * หยุดหรือปล่อย effect ใหม่โดยไม่แตะ stage
   *
   * นี่คือปุ่ม rollback จริง ๆ: ของที่เกิดไปแล้ว (receipt, enrollment, audit) ยังอยู่ครบ
   * และเปิดกลับได้เมื่อแก้ปัญหาเสร็จ ต่างจากการย้อน stage ที่ทำไม่ได้และไม่ควรทำ
   */
  async setFrozen(input: {
    tenantId: string;
    frozen: boolean;
    expectedVersion: number;
    updatedByRef: string;
  }): Promise<SegmentRolloutView> {
    const current = await this.read(input.tenantId);
    if (current.version !== input.expectedVersion) {
      throw new SegmentRolloutVersionConflictError(input.expectedVersion, current.version);
    }
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const updated = await transaction.jrSegmentRolloutState.update({
        where: { tenantId: input.tenantId },
        data: {
          mutationFrozen: input.frozen,
          updatedByRef: input.updatedByRef,
          version: { increment: 1 },
        },
        select: {
          stage: true,
          mutationFrozen: true,
          version: true,
          shadowStartedAt: true,
          switchedAt: true,
        },
      });
      return this.toView(updated);
    });
  }

  /**
   * enrollment เกิดได้ก็ต่อเมื่อเปิดเต็มรูปแบบและไม่ถูก freeze
   *
   * รวมสองเงื่อนไขไว้ที่เดียวเพราะถ้าแยกกันถาม ผู้เรียกจะลืมข้อใดข้อหนึ่งได้ และผลของการลืม
   * คือ effect ที่ไม่ควรเกิดหลุดออกไปหาลูกค้าจริง
   */
  async canEmitEffects(tenantId: string): Promise<boolean> {
    const view = await this.read(tenantId);
    return view.stage === 'SCOPED_INTERNAL_ENABLED' && !view.mutationFrozen;
  }

  /**
   * บันทึก mismatch ระหว่าง shadow — เก็บได้แค่ digest ไม่มีค่า attribute
   *
   * ซ้ำได้ไม่จำกัดเพราะ unique key กันไว้: shadow วนรอบหลายครั้งต่อ revision เดียวกัน การ
   * บันทึกซ้ำทุกรอบจะทำให้รายงานบวมจนอ่านไม่ออกและซ่อน mismatch ตัวใหม่
   */
  async recordMismatch(
    input: ShadowComparisonInput,
  ): Promise<'RECORDED' | 'MATCHED' | 'DUPLICATE'> {
    if (input.expectedDigest === input.observedDigest) return 'MATCHED';
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const existing = await transaction.jrSegmentShadowMismatch.findUnique({
        where: {
          tenantId_contactId_segmentId_membershipRevision_mismatchKind: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            segmentId: input.segmentId,
            membershipRevision: input.membershipRevision,
            mismatchKind: 'STATE_DIGEST',
          },
        },
        select: { id: true },
      });
      if (existing) return 'DUPLICATE' as const;
      await transaction.jrSegmentShadowMismatch.create({
        data: {
          tenantId: input.tenantId,
          contactId: input.contactId,
          segmentId: input.segmentId,
          membershipRevision: input.membershipRevision,
          mismatchKind: 'STATE_DIGEST',
          expectedDigest: input.expectedDigest,
          observedDigest: input.observedDigest,
        },
      });
      return 'RECORDED' as const;
    });
  }

  private toView(row: {
    stage: string;
    mutationFrozen: boolean;
    version: number;
    shadowStartedAt: Date | null;
    switchedAt: Date | null;
  }): SegmentRolloutView {
    return {
      stage: row.stage as SegmentRolloutStage,
      mutationFrozen: row.mutationFrozen,
      version: row.version,
      shadowStartedAt: row.shadowStartedAt?.toISOString() ?? null,
      switchedAt: row.switchedAt?.toISOString() ?? null,
    };
  }
}
