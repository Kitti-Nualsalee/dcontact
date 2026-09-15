/**
 * J3.7 (#218) — ประเมิน membership ใหม่หลัง LEFT/CORRECTED/REFILTER_REQUIRED/IDENTITY_INVALIDATED
 *
 * งาน re-filter ถูกสร้างไว้ตอน apply receipt (J3.6) แล้วรอให้ที่นี่ตัดสิน — แยกกันเพราะตอน apply
 * เรายังไม่รู้ผลจริง การรีบตัดสินตอนนั้นคือการ re-filter ด้วยข้อมูลครึ่งเดียว
 *
 * หลักสำคัญ: ตัดสินจาก canonical fact ปัจจุบันเท่านั้น ไม่ใช่จาก event ที่พามาถึง — event บอกแค่
 * ว่า "มีอะไรเปลี่ยน" ส่วน "ตอนนี้จริง ๆ เป็นอย่างไร" ต้องถาม Customer 360 ใหม่ทุกครั้ง
 *
 * สไลซ์นี้ครอบวงจรชีวิตของ cursor กับการตัดสินใจ ส่วนการยกเลิกงานฝั่ง owner (pre-barrier
 * cancel/release เทียบกับ post-barrier CANCEL_REQUESTED → RECONCILING) เป็นสไลซ์ถัดไป
 */
import type { Prisma, PrismaClient } from '@d-contact/db';
import {
  contactId as toContactId,
  membershipRevision as toMembershipRevision,
  segmentEntryId as toSegmentEntryId,
  segmentId as toSegmentId,
  teamId as toTeamId,
  tenantId as toTenantId,
  type CustomerSegmentMembershipReader,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import type { JourneyDefinitionRepository } from './journey-definition-repository.js';
import { JourneySegmentReceiptRepository } from './journey-segment-receipt-repository.js';

export type RefilterOutcome =
  'NO_OP' | 'CANCELLED' | 'DEFERRED' | 'HELD' | 'RECONCILING' | undefined;

export interface JourneySegmentRefilterProcessorPorts {
  membershipReader: CustomerSegmentMembershipReader<Prisma.TransactionClient>;
  teamContactScopeAuthorizer: TeamContactScopeAuthorizer<Prisma.TransactionClient>;
}

export interface JourneySegmentRefilterProcessorOptions {
  now?: () => Date;
  id?: () => string;
  retryDelayMs?: number;
  leaseSeconds?: number;
}

export class JourneySegmentRefilterProcessor {
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly leaseSeconds: number;
  private readonly receipts: JourneySegmentReceiptRepository;

  constructor(
    database: PrismaClient,
    private readonly definitions: JourneyDefinitionRepository,
    private readonly ports: JourneySegmentRefilterProcessorPorts,
    options: JourneySegmentRefilterProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.receipts = new JourneySegmentReceiptRepository(database, {
      ...(options.id ? { id: options.id } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /** ประมวลผลงาน re-filter ได้สูงสุดหนึ่งใบต่อครั้ง; caller กำหนด polling loop เอง */
  async executeNext(tenantId: string, workerId: string): Promise<RefilterOutcome> {
    const cursor = await this.receipts.claimNextRefilter(tenantId, workerId, this.leaseSeconds);
    if (!cursor) return undefined;

    const receipt = cursor.receipt;

    /**
     * merge/split/unmerge ทำให้ stream เดิมไม่ใช่ความจริงอีกต่อไป — ต้องรอ canonical fact ใบใหม่
     * จาก Customer 360 ไม่ใช่เดาเองว่า enrollment ควรย้ายไปไหน การย้ายหรือโคลน enrollment ของ
     * predecessor ไปหา survivor เป็นสิ่งที่ stop condition ของ #218 ห้ามตรง ๆ
     */
    if (receipt?.changeKind === 'IDENTITY_INVALIDATED') {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'RECONCILING',
        'IDENTITY_LINEAGE_CONFLICT',
        this.retryDelayMs,
      );
      return 'RECONCILING';
    }

    /**
     * ไม่มี entryId = บอกได้แค่ว่า "ต้องประเมินใหม่" แต่ไม่รู้ว่าประเมิน entry ไหน
     * (REFILTER_REQUIRED จาก identity lineage ฝั่ง target) ต้องรอ fact ที่ชี้ entry ชัดเจน
     */
    if (!receipt?.entryId) {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'RECONCILING',
        'RECONCILIATION_REQUIRED',
        this.retryDelayMs,
      );
      return 'RECONCILING';
    }

    const at = this.now().toISOString();
    const resolution = await this.ports.membershipReader.resolveEntry({
      tenantId: toTenantId(tenantId),
      contactId: toContactId(cursor.contactId),
      segmentId: toSegmentId(cursor.segmentId),
      entryId: toSegmentEntryId(receipt.entryId),
      membershipRevision: toMembershipRevision(cursor.membershipRevision),
      at,
    });

    if (resolution.status === 'STALE') {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'DEFERRED',
        'MEMBERSHIP_CONTEXT_STALE',
        this.retryDelayMs,
      );
      return 'DEFERRED';
    }
    if (resolution.status === 'AMBIGUOUS' || resolution.status === 'NOT_FOUND') {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'RECONCILING',
        resolution.reasonCode,
        this.retryDelayMs,
      );
      return 'RECONCILING';
    }

    /**
     * ไม่ eligible แล้ว = ต้องยกเลิกงานที่ค้างอยู่ของ entry นี้
     *
     * ปิด cursor เป็น CANCELLED ทันทีที่นี่ไม่ได้ก่อนจะมีชั้นยกเลิกงานฝั่ง owner จริง — แต่การ
     * ตัดสินว่า "ต้องยกเลิก" เป็นของรอบนี้ และเป็น fact ที่เสถียรแล้วเพราะถามจาก canonical
     */
    if (resolution.status !== 'ELIGIBLE') {
      await this.receipts.settleRefilter(
        tenantId,
        cursor.id,
        'CANCELLED',
        'SEGMENT_ENTRY_NOT_ELIGIBLE',
      );
      return 'CANCELLED';
    }

    /**
     * ยังอยู่ใน segment ด้วย entryId เดิม = correction ที่ไม่เปลี่ยนความเป็นสมาชิก
     * ห้ามสร้าง entry ใหม่หรือ enrollment ใหม่จากเหตุนี้ — การเข้าใหม่ต้องมากับ ENTERED เท่านั้น
     */
    if (resolution.entryId !== receipt.entryId) {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'RECONCILING',
        'INVALID_MEMBERSHIP_TRANSITION',
        this.retryDelayMs,
      );
      return 'RECONCILING';
    }

    const matched = await this.definitions.findPublishedBySegmentTrigger(
      tenantId,
      cursor.segmentId,
    );
    if (matched.length === 0) {
      await this.receipts.settleRefilter(tenantId, cursor.id, 'NO_OP', 'NO_MATCHING_JOURNEY');
      return 'NO_OP';
    }

    const scopes = await Promise.all(
      matched.map((definition) =>
        this.ports.teamContactScopeAuthorizer.authorize({
          tenantId: toTenantId(tenantId),
          teamId: toTeamId(definition.ownerTeamId),
          contactId: toContactId(resolution.contactId),
          permission: 'WORK',
          at,
        }),
      ),
    );

    if (scopes.some((scope) => scope.decision === 'DEFER')) {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'DEFERRED',
        'SCOPE_CONTEXT_STALE',
        this.retryDelayMs,
      );
      return 'DEFERRED';
    }

    /**
     * scope ถูกเพิกถอนหลัง enroll ไปแล้ว = งานที่ค้างต้องถูกยกเลิก ไม่ใช่ปล่อยให้เดินต่อ
     * และห้ามบันทึกเป็น Governance BLOCK เพราะนี่เป็นเรื่องสิทธิ์ของทีม ไม่ใช่นโยบายติดต่อลูกค้า
     */
    if (scopes.every((scope) => scope.decision === 'DENY')) {
      await this.receipts.settleRefilter(
        tenantId,
        cursor.id,
        'CANCELLED',
        'TEAM_SEGMENT_NOT_ALLOWED',
      );
      return 'CANCELLED';
    }

    // ทุกอย่างยังเหมือนเดิม — correction ไม่ได้เปลี่ยนอะไรที่ Journey ต้องทำ
    await this.receipts.settleRefilter(tenantId, cursor.id, 'NO_OP', 'MEMBERSHIP_UNCHANGED');
    return 'NO_OP';
  }
}
