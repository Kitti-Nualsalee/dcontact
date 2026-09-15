/**
 * J3.10 (#221) — baseline membership ที่มีอยู่ก่อนเปิดใช้ J3 และ rebuild projection
 *
 * หัวใจของเรื่องนี้คือสิ่งที่ห้ามทำ: **contact ที่อยู่ใน segment อยู่แล้วก่อนเปิดระบบ ต้องไม่ถูก
 * enroll** เพราะการเข้า segment ของเขาเกิดไปแล้วในอดีต ไม่ใช่เหตุการณ์ที่เพิ่งเกิด การสร้าง
 * enrollment ให้ทุกคนตอนเปิดระบบเท่ากับยิงแคมเปญใส่ฐานลูกค้าทั้งหมดพร้อมกันโดยไม่มีใครสั่ง
 *
 * baseline จึงเขียนแค่ head ให้ตรงกับ revision ปัจจุบันของ Customer 360 — ไม่มี receipt ที่
 * พา entry, ไม่มี intent, ไม่มี outbox หลังจากนั้น revision ถัดไปที่มาจริงจะถูกประมวลผลตามปกติ
 * และ OUT -> IN ของจริงเท่านั้นที่สร้าง entry ใหม่
 *
 * ทำซ้ำได้เสมอ: ทุกครั้งที่รันได้ผลเท่าเดิม และ head ที่ขยับไปไกลกว่าแล้วจะไม่ถูกดึงถอยหลัง
 */
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export interface SegmentBaselineResult {
  /** stream ที่ถูกตั้ง baseline ในรอบนี้ */
  baselined: number;
  /** stream ที่มี head อยู่แล้วและไม่ต้องแตะ */
  skipped: number;
  /** cursor สำหรับเรียกต่อ — undefined แปลว่าจบแล้ว */
  nextCursor?: { contactId: string; segmentId: string };
}

export interface SegmentBaselineInput {
  tenantId: string;
  /** จำนวน stream ต่อรอบ — ให้ caller คุมขนาด transaction เอง */
  batchSize?: number;
  /** ตำแหน่งที่ค้างไว้จากรอบก่อน */
  cursor?: { contactId: string; segmentId: string };
}

export class JourneySegmentBaseline {
  constructor(private readonly database: PrismaClient) {}

  /**
   * ตั้ง baseline ทีละชุดแบบ resumable
   *
   * เรียงด้วย (contactId, segmentId) ซึ่งเป็น primary key ของ C360 head — ลำดับจึงเสถียร
   * ข้ามรอบและข้ามการรีสตาร์ท ต่างจากการเรียงด้วยเวลาที่แถวใหม่จะแทรกกลางชุดที่ทำไปแล้ว
   * แล้วทำให้ stream บางเส้นถูกข้ามไปเงียบ ๆ
   */
  async baselineNext(input: SegmentBaselineInput): Promise<SegmentBaselineResult> {
    const batchSize = input.batchSize ?? 100;
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const memberships = await transaction.c360SegmentMembershipHead.findMany({
        where: {
          tenantId: input.tenantId,
          ...(input.cursor
            ? {
                OR: [
                  { contactId: { gt: input.cursor.contactId } },
                  {
                    contactId: input.cursor.contactId,
                    segmentId: { gt: input.cursor.segmentId },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ contactId: 'asc' }, { segmentId: 'asc' }],
        take: batchSize,
        select: {
          contactId: true,
          segmentId: true,
          membershipRevision: true,
          state: true,
          entryId: true,
        },
      });
      if (memberships.length === 0) return { baselined: 0, skipped: 0 };

      let baselined = 0;
      let skipped = 0;
      for (const membership of memberships) {
        const key = {
          tenantId_contactId_segmentId: {
            tenantId: input.tenantId,
            contactId: membership.contactId,
            segmentId: membership.segmentId,
          },
        };
        const existing = await transaction.jrSegmentHead.findUnique({
          where: key,
          select: { lastAppliedRevision: true },
        });

        /**
         * head ที่มีอยู่แล้วไม่ถูกแตะเลย ไม่ว่าจะสูงหรือต่ำกว่า revision ปัจจุบัน
         *
         * สูงกว่า = ระบบเดินไปไกลแล้ว การดึงถอยจะทำให้ revision ที่ apply ไปแล้วถูกประมวลผลซ้ำ
         * ต่ำกว่า = มี revision ค้างรออยู่จริง การกระโดดไปข้างหน้าจะกลืนมันหายโดยไม่มีใครรู้
         */
        if (existing) {
          skipped += 1;
          continue;
        }

        await transaction.jrSegmentHead.create({
          data: {
            tenantId: input.tenantId,
            contactId: membership.contactId,
            segmentId: membership.segmentId,
            lastAppliedRevision: membership.membershipRevision,
            /**
             * ไม่ตั้ง terminal แม้ membership ปัจจุบันจะเป็น OUT/INVALIDATED
             *
             * terminal คือบันทึกว่า "entry นี้ถูกปิดโดยเหตุการณ์ที่ J3 เห็น" แต่ baseline ไม่ได้
             * เห็นเหตุการณ์นั้น การเขียนลงไปคือการแต่งประวัติที่ไม่เคยผ่านระบบนี้
             */
          },
        });
        baselined += 1;
      }

      const last = memberships[memberships.length - 1]!;
      return {
        baselined,
        skipped,
        ...(memberships.length === batchSize
          ? { nextCursor: { contactId: last.contactId, segmentId: last.segmentId } }
          : {}),
      };
    });
  }

  /** ไล่ baseline จนจบทั้ง tenant — รวมผลของทุกรอบเข้าด้วยกัน */
  async baselineTenant(
    tenantId: string,
    batchSize = 100,
  ): Promise<{ baselined: number; skipped: number; batches: number }> {
    let cursor: SegmentBaselineResult['nextCursor'];
    let baselined = 0;
    let skipped = 0;
    let batches = 0;
    do {
      const result: SegmentBaselineResult = await this.baselineNext({
        tenantId,
        batchSize,
        ...(cursor ? { cursor } : {}),
      });
      baselined += result.baselined;
      skipped += result.skipped;
      batches += 1;
      cursor = result.nextCursor;
    } while (cursor);
    return { baselined, skipped, batches };
  }

  /**
   * สร้าง head ใหม่จาก receipt ที่ apply แล้วเท่านั้น
   *
   * ใช้ตอน projection เสียหายและต้องประกอบใหม่ — อ่านจาก receipt ledger ซึ่งเป็น fact ที่ผ่าน
   * ระบบมาจริง ไม่ใช่จาก Customer 360 โดยตรง เพราะ head ของ J3 ต้องสะท้อนว่า "J3 ประมวลผล
   * อะไรไปแล้ว" ไม่ใช่ "ตอนนี้ Customer 360 ว่าอย่างไร" สองอย่างนี้ต่างกันตอนมี revision ค้าง
   *
   * ไม่แตะ intent, enrollment หรือ outbox เลย — rebuild projection ไม่ใช่การ replay effect
   */
  async rebuildHead(
    tenantId: string,
    contactId: string,
    segmentId: string,
  ): Promise<{ lastAppliedRevision: number; rebuilt: boolean }> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`jr-segment-stream:${tenantId}:${contactId}:${segmentId}`}))`,
      );
      const applied = await transaction.jrSegmentReceipt.findFirst({
        where: { tenantId, contactId, segmentId, state: 'APPLIED' },
        orderBy: { membershipRevision: 'desc' },
        select: { id: true, membershipRevision: true },
      });
      if (!applied) return { lastAppliedRevision: 0, rebuilt: false };

      const key = { tenantId_contactId_segmentId: { tenantId, contactId, segmentId } };
      const head = await transaction.jrSegmentHead.findUnique({
        where: key,
        select: { lastAppliedRevision: true },
      });
      if (head?.lastAppliedRevision === applied.membershipRevision) {
        return { lastAppliedRevision: applied.membershipRevision, rebuilt: false };
      }

      await transaction.jrSegmentHead.upsert({
        where: key,
        create: {
          tenantId,
          contactId,
          segmentId,
          lastAppliedRevision: applied.membershipRevision,
          lastAppliedReceiptId: applied.id,
        },
        update: {
          lastAppliedRevision: applied.membershipRevision,
          lastAppliedReceiptId: applied.id,
        },
      });
      return { lastAppliedRevision: applied.membershipRevision, rebuilt: true };
    });
  }
}
