/**
 * J2.8 (#136) — `ACK_UNKNOWN` escalation policy และ bounded reconciliation deadlines
 *
 * `JourneyOwnerResultReconciler` เขียนกำกับตัวเองไว้ว่า "ACK_UNKNOWN escalation เป็นการ
 * ตัดสินใจของ caller เอง ไม่ใช่ที่นี่" — แต่ไม่เคยมี caller ไหนทำหน้าที่นั้น ผลคือ action
 * ที่ owner ไม่ตอบจะค้างอยู่ที่ `DISPATCHED` ตลอดไปโดยไม่มีอะไรไล่ตามและไม่มีใครรู้
 *
 * ลำดับที่ตั้งใจให้เป็น ตามที่ #136 ระบุ ("ACK_UNKNOWN query owner ก่อน retry, bounded retry
 * และ reconciliation deadlines"):
 *
 *   1. เกิน `ackDeadlineMs` นับจาก dispatch แล้วยังไม่มีผล -> ย้ายเป็น `ACK_UNKNOWN`
 *      ไม่ใช่ retry ทันที เพราะเราไม่รู้ว่า owner ทำไปแล้วหรือยัง การส่งซ้ำมั่ว ๆ
 *      อาจสร้าง Case/Callback ซ้ำ
 *   2. **ถาม owner ก่อนเสมอ** ผ่าน reconciler ถ้ามีผลอยู่แล้วก็ apply แล้วจบ
 *   3. ยังไม่มีผล -> นับ attempt เพิ่ม แล้วรอรอบถัดไป
 *   4. ครบ `maxAttempts` -> หยุดไล่ตามเอง บันทึก `JrRecoveryAudit` ไว้เป็นหลักฐานแล้ว
 *      ส่งต่อให้คนตัดสินใจผ่าน admin recovery API (#235) — นี่คือ "bounded" ของสเปค
 *      ระบบไม่วนเรียก owner ไปเรื่อย ๆ และไม่เงียบหายไปเฉย ๆ
 *
 * action ที่ถูก escalate แล้วยังอยู่ใน `ACK_UNKNOWN` ซึ่งเป็น open state — ถ้าผลมาช้าทีหลัง
 * (ทาง result consumer) ก็ยัง apply ได้ตามปกติ การ escalate ไม่ได้ปิดประตูนั้น
 */
import type { PrismaClient } from '@d-contact/db';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneyRecoveryAuditLog } from './journey-recovery-audit.js';
import type { JourneyOwnerResultReconciler } from './journey-owner-result-reconciler.js';

export type AckEscalationOutcome =
  /** ถาม owner แล้วได้ผลจริง apply เรียบร้อย */
  | 'RECONCILED'
  /** ยังไม่มีผล นับ attempt แล้วรอรอบหน้า */
  | 'WAITING'
  /** ครบเพดาน retry แล้ว ส่งต่อให้คนผ่าน admin recovery API */
  | 'ESCALATED'
  /** แพ้ race กับผลที่เพิ่งมาถึง — ปล่อยให้ฝั่งนั้นชนะ */
  | 'SUPERSEDED';

export interface JourneyOwnerAckEscalatorOptions {
  now?: () => Date;
  /** เงียบเกินเท่านี้นับจาก dispatch ถือว่าไม่รู้ผล */
  ackDeadlineMs?: number;
  /** ถาม owner ได้กี่รอบก่อนส่งต่อให้คน */
  maxAttempts?: number;
  actorId?: string;
}

const DEFAULT_ACK_DEADLINE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
/**
 * `jr_recovery_audit.actor_id` เป็น UUID เพราะปกติเป็นผู้ใช้จริง — escalation เป็นการ
 * ตัดสินใจของระบบ จึงใช้ UUID คงที่ตัวนี้แทน เพื่อให้ query แยก "ระบบทำเอง" ออกจาก
 * "คนสั่ง" ได้ชัดเจนโดยไม่ต้องแก้ชนิดคอลัมน์
 */
export const ACK_ESCALATOR_ACTOR_ID = '00000000-0000-4000-8000-000000000a28';

export class JourneyOwnerAckEscalator {
  private readonly actions: JourneyOwnerActionRepository;
  private readonly audit: JourneyRecoveryAuditLog;
  private readonly now: () => Date;
  private readonly ackDeadlineMs: number;
  private readonly maxAttempts: number;
  private readonly actorId: string;

  constructor(
    database: PrismaClient,
    private readonly reconciler: JourneyOwnerResultReconciler,
    options: JourneyOwnerAckEscalatorOptions = {},
  ) {
    this.actions = new JourneyOwnerActionRepository(database);
    this.audit = new JourneyRecoveryAuditLog(database);
    this.now = options.now ?? (() => new Date());
    this.ackDeadlineMs = options.ackDeadlineMs ?? DEFAULT_ACK_DEADLINE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.actorId = options.actorId ?? ACK_ESCALATOR_ACTOR_ID;
  }

  /** จัดการหนึ่ง action ต่อครั้ง; คืน undefined เมื่อไม่มีอะไรค้างแล้ว */
  async escalateNext(tenantId: string): Promise<AckEscalationOutcome | undefined> {
    const deadline = new Date(this.now().getTime() - this.ackDeadlineMs);
    const [stale] = await this.actions.findStaleDispatched(tenantId, deadline, this.maxAttempts, 1);
    if (!stale) return undefined;

    const marked = await this.actions.markAckUnknown(tenantId, stale.actionKey, stale.version);
    // แพ้ race กับผลที่เพิ่งมาถึงพอดี — ฝั่งนั้นถูกต้องกว่า ไม่ต้องทำอะไรต่อ
    if (!marked) return 'SUPERSEDED';

    // ถาม owner ก่อนเสมอ ห้าม retry แบบมั่ว ๆ
    const reconciled = await this.reconciler.reconcile(tenantId, stale.actionKey);
    if (reconciled !== 'NO_RESULT_YET') return 'RECONCILED';

    if (marked.attempts < this.maxAttempts) return 'WAITING';

    await this.audit.record({
      tenantId,
      operation: 'RECONCILE',
      targetKind: 'ACTION',
      targetRef: stale.actionKey,
      reasonCode: 'ACK_UNKNOWN_DEADLINE_EXCEEDED',
      actorId: this.actorId,
    });
    return 'ESCALATED';
  }
}
