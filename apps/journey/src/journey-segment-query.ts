/**
 * J3.8 (#219) — sanitized read ของ segment membership stream สำหรับงาน forensic
 *
 * "sanitized" ที่นี่ไม่ได้แปลว่ากรอง PII ออกทีหลัง แต่แปลว่า **ไม่เคยอ่านคอลัมน์ที่อาจมี PII
 * ขึ้นมาเลย** — ทุก select ระบุ field ชัดเจน ไม่มี `findMany()` เปล่า ๆ ที่ลากทั้งแถวขึ้นมาแล้ว
 * ค่อยหวังว่าจะ map ออกครบ เพราะวันที่มีคนเพิ่มคอลัมน์ใหม่ วิธีหลังจะรั่วเงียบ ๆ
 *
 * payload ของ outbox กับ reason ของ intent ไม่ถูกคืนออกไปเลย: intent เก็บแค่ ref/version/digest
 * อยู่แล้วก็จริง แต่ digest คือค่าที่ใช้ยืนยันความถูกต้อง ไม่ใช่ค่าที่ operator ต้องเห็น
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export interface SegmentReceiptView {
  receiptId: string;
  source: string;
  eventId: string;
  membershipRevision: number;
  changeKind: string;
  entryId: string | null;
  supersedesRevision: number | null;
  state: string;
  attempts: number;
  reviewReasonCode: string | null;
  receivedAt: string;
  appliedAt: string | null;
}

export interface SegmentRefilterView {
  cursorId: string;
  membershipRevision: number;
  state: string;
  attempts: number;
  reasonCode: string | null;
  availableAt: string;
  settledAt: string | null;
}

export interface SegmentEnrollmentView {
  intentId: string;
  journeyId: string;
  journeyVersion: number;
  entryId: string;
  reasonMembershipRevision: number;
  reasonDefinitionVersion: number;
  enrollmentId: string | null;
  enrollmentState: string | null;
  runState: string | null;
  terminalReason: string | null;
}

export interface SegmentStreamView {
  contactId: string;
  segmentId: string;
  lastAppliedRevision: number;
  terminalEntryId: string | null;
  terminalRevision: number | null;
  terminalReasonCode: string | null;
  updatedAt: string;
  /**
   * revision ที่ยังไม่ถูก apply และไม่มี receipt รองรับ — คือรูที่ operator ต้องตามหา
   * คำนวณจาก receipt ที่มีอยู่จริง ไม่ใช่เดาจาก head อย่างเดียว
   */
  gaps: number[];
  receipts: SegmentReceiptView[];
  refilters: SegmentRefilterView[];
  enrollments: SegmentEnrollmentView[];
  recoveries: { operation: string; targetRef: string; reasonCode: string; recordedAt: string }[];
}

export class JourneySegmentQuery {
  constructor(private readonly database: PrismaClient) {}

  /** คืน undefined เมื่อไม่มี stream นี้ — caller ต้องแปลงเป็น 404 แบบเดียวกับที่ไม่เคยมีอยู่จริง */
  async readStream(
    tenantId: string,
    contactId: string,
    segmentId: string,
  ): Promise<SegmentStreamView | undefined> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const head = await transaction.jrSegmentHead.findUnique({
        where: { tenantId_contactId_segmentId: { tenantId, contactId, segmentId } },
        select: {
          lastAppliedRevision: true,
          terminalEntryId: true,
          terminalRevision: true,
          terminalReasonCode: true,
          updatedAt: true,
        },
      });
      if (!head) return undefined;

      const receipts = await transaction.jrSegmentReceipt.findMany({
        where: { tenantId, contactId, segmentId },
        orderBy: { membershipRevision: 'asc' },
        select: {
          id: true,
          source: true,
          eventId: true,
          membershipRevision: true,
          changeKind: true,
          entryId: true,
          supersedesRevision: true,
          state: true,
          attempts: true,
          reviewReasonCode: true,
          receivedAt: true,
          appliedAt: true,
        },
      });

      const refilters = await transaction.jrSegmentRefilterCursor.findMany({
        where: { tenantId, contactId, segmentId },
        orderBy: { membershipRevision: 'asc' },
        select: {
          id: true,
          membershipRevision: true,
          state: true,
          attempts: true,
          reasonCode: true,
          availableAt: true,
          settledAt: true,
        },
      });

      const intents = await transaction.jrSegmentEnrollmentIntent.findMany({
        where: { tenantId, contactId, segmentId },
        orderBy: [{ entryId: 'asc' }, { journeyId: 'asc' }],
        select: {
          id: true,
          journeyId: true,
          journeyVersion: true,
          entryId: true,
          reasonMembershipRevision: true,
          reasonDefinitionVersion: true,
          enrollment: {
            select: { id: true, state: true, runState: true, terminalReason: true },
          },
        },
      });

      const recoveries = await transaction.jrRecoveryAudit.findMany({
        where: {
          tenantId,
          targetKind: { in: ['SEGMENT_RECEIPT', 'SEGMENT_REFILTER'] },
          targetRef: {
            in: [
              ...receipts.map((receipt) => receipt.eventId),
              ...refilters.map((cursor) => cursor.id),
            ],
          },
        },
        orderBy: { occurredAt: 'asc' },
        select: { operation: true, targetRef: true, reasonCode: true, occurredAt: true },
      });

      return {
        contactId,
        segmentId,
        lastAppliedRevision: head.lastAppliedRevision,
        terminalEntryId: head.terminalEntryId,
        terminalRevision: head.terminalRevision,
        terminalReasonCode: head.terminalReasonCode,
        updatedAt: head.updatedAt.toISOString(),
        gaps: findGaps(receipts.map((receipt) => receipt.membershipRevision)),
        receipts: receipts.map((receipt) => ({
          receiptId: receipt.id,
          source: receipt.source,
          eventId: receipt.eventId,
          membershipRevision: receipt.membershipRevision,
          changeKind: receipt.changeKind,
          entryId: receipt.entryId,
          supersedesRevision: receipt.supersedesRevision,
          state: receipt.state,
          attempts: receipt.attempts,
          reviewReasonCode: receipt.reviewReasonCode,
          receivedAt: receipt.receivedAt.toISOString(),
          appliedAt: receipt.appliedAt?.toISOString() ?? null,
        })),
        refilters: refilters.map((cursor) => ({
          cursorId: cursor.id,
          membershipRevision: cursor.membershipRevision,
          state: cursor.state,
          attempts: cursor.attempts,
          reasonCode: cursor.reasonCode,
          availableAt: cursor.availableAt.toISOString(),
          settledAt: cursor.settledAt?.toISOString() ?? null,
        })),
        enrollments: intents.map((intent) => ({
          intentId: intent.id,
          journeyId: intent.journeyId,
          journeyVersion: intent.journeyVersion,
          entryId: intent.entryId,
          reasonMembershipRevision: intent.reasonMembershipRevision,
          reasonDefinitionVersion: intent.reasonDefinitionVersion,
          enrollmentId: intent.enrollment?.id ?? null,
          enrollmentState: intent.enrollment?.state ?? null,
          runState: intent.enrollment?.runState ?? null,
          terminalReason: intent.enrollment?.terminalReason ?? null,
        })),
        recoveries: recoveries.map((entry) => ({
          operation: entry.operation,
          targetRef: entry.targetRef,
          reasonCode: entry.reasonCode,
          recordedAt: entry.occurredAt.toISOString(),
        })),
      };
    });
  }
}

/**
 * รูของ stream คือ revision ที่ไม่มี receipt เลย ระหว่างตัวแรกกับตัวสุดท้ายที่เห็น
 *
 * ไม่ไล่จาก 1 เสมอ เพราะ retention อาจลบ revision เก่าไปแล้วอย่างถูกต้อง การรายงานว่ามันคือรู
 * จะทำให้ operator ไล่ตามสิ่งที่ตั้งใจลบทิ้ง
 */
function findGaps(revisions: readonly number[]): number[] {
  if (revisions.length === 0) return [];
  const present = new Set(revisions);
  const gaps: number[] = [];
  for (let revision = revisions[0]!; revision < revisions[revisions.length - 1]!; revision += 1) {
    if (!present.has(revision)) gaps.push(revision);
  }
  return gaps;
}
