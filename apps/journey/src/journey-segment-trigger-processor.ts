/**
 * J3.6 (#217) — apply phase ของ segment membership receipt
 *
 * ปิดวงจรระหว่าง consumer (ingest) กับ repository (persist): claim receipt ที่ READY หนึ่งใบ,
 * re-read exact entry จาก Customer 360, ตรวจ current team scope, match published
 * SEGMENT_ENTRY definitions แล้วจึงตัดสินว่าจะ enroll, re-filter, ปล่อยผ่าน หรือส่งไป review
 *
 * resolve ทุกอย่างนอก transaction (read-only) แล้วค่อยเปิดทรานแซกชันเดียวตอน persist —
 * ไม่ถือ DB lock ระหว่างรอ Customer 360 หรือ IAM ตอบ แบบเดียวกับ J2.7
 *
 * caller ส่ง snapshot ของ membership หรือ scope เข้ามาเป็น authority ไม่ได้: ค่าเดียวที่เชื่อถือ
 * คือสิ่งที่ resolveEntry กับ authorizer ตอบ ณ เวลาที่ประมวลผลจริง ไม่ใช่ค่าที่ติดมากับ event
 * (stop condition ของ #217)
 */
import { createHash } from 'node:crypto';
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
import { canonicalJson } from './event-inbox.js';
import type { JourneyDefinitionRepository } from './journey-definition-repository.js';
import {
  JourneySegmentReceiptRepository,
  type SegmentEnrollmentIntentInput,
} from './journey-segment-receipt-repository.js';

export type SegmentTriggerOutcome =
  | 'ENROLLED'
  | 'REFILTERED'
  | 'NO_MATCH'
  | 'NOT_ELIGIBLE'
  | 'DEFERRED'
  | 'DENIED'
  | 'REVIEW'
  | undefined;

export interface JourneySegmentTriggerProcessorPorts {
  membershipReader: CustomerSegmentMembershipReader<Prisma.TransactionClient>;
  teamContactScopeAuthorizer: TeamContactScopeAuthorizer<Prisma.TransactionClient>;
}

export interface JourneySegmentTriggerProcessorOptions {
  now?: () => Date;
  id?: () => string;
  retryDelayMs?: number;
  leaseSeconds?: number;
}

/** change kind ที่พา "การเข้า segment ครั้งใหม่" มาด้วย — ที่เหลือเป็นงานของ re-filter */
const ENTRY_CHANGE_KINDS = new Set(['ENTERED']);

export class JourneySegmentTriggerProcessor {
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly leaseSeconds: number;
  private readonly receipts: JourneySegmentReceiptRepository;

  constructor(
    database: PrismaClient,
    private readonly definitions: JourneyDefinitionRepository,
    private readonly ports: JourneySegmentTriggerProcessorPorts,
    options: JourneySegmentTriggerProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.receipts = new JourneySegmentReceiptRepository(database, {
      ...(options.id ? { id: options.id } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /** ประมวลผล receipt ที่ READY ได้สูงสุดหนึ่งใบต่อครั้ง; caller กำหนด polling loop เอง */
  async executeNext(tenantId: string, workerId: string): Promise<SegmentTriggerOutcome> {
    const claimed = await this.receipts.claimNextReady(tenantId, workerId, this.leaseSeconds);
    if (!claimed) return undefined;

    const at = this.now().toISOString();

    /**
     * change ที่ไม่ใช่การเข้าใหม่ (LEFT/CORRECTED/REFILTER_REQUIRED/IDENTITY_INVALIDATED)
     * ไม่ต้อง resolve อะไรเลยที่นี่ — บันทึกเป็นงานรอประเมินแล้วให้ J3.7 ทำต่อ การพยายาม
     * ตัดสินแทนมันที่นี่จะกลายเป็นการ re-filter ด้วยข้อมูลครึ่งเดียว
     */
    if (!ENTRY_CHANGE_KINDS.has(claimed.changeKind)) {
      await this.receipts.applyRefilter(
        {
          tenantId,
          receiptId: claimed.id,
          reasonCode: claimed.changeKind,
          // LEFT ปิด entry นั้นถาวร ส่วน kind อื่นแค่สั่งให้ประเมินใหม่
          ...(claimed.changeKind === 'LEFT' && claimed.entryId
            ? { terminalEntryId: claimed.entryId }
            : {}),
          correlationId: claimed.correlationId,
        },
        this.outboxEvent(claimed.contactId, claimed.segmentId, {
          kind: 'REFILTER_REQUESTED',
          reasonCode: claimed.changeKind,
        }),
      );
      return 'REFILTERED';
    }

    if (!claimed.entryId) {
      // ENTERED ที่ไม่มี entryId ขัดกับ contract เอง — เป็นความผิดปกติที่ต้องมีคนดู
      await this.receipts.markReview(tenantId, claimed.id, 'PAYLOAD_VALIDATION_FAILED');
      return 'REVIEW';
    }

    const resolution = await this.ports.membershipReader.resolveEntry({
      tenantId: toTenantId(tenantId),
      contactId: toContactId(claimed.contactId),
      segmentId: toSegmentId(claimed.segmentId),
      entryId: toSegmentEntryId(claimed.entryId),
      membershipRevision: toMembershipRevision(claimed.membershipRevision),
      at,
    });

    if (resolution.status === 'STALE') {
      // context ยังตามไม่ทัน ไม่ใช่ว่าไม่มีสิทธิ์ — ต้องเริ่มประเมินใหม่ทั้งหมดในรอบถัดไป
      await this.receipts.markRetryableFailure(
        tenantId,
        claimed.id,
        this.retryDelayMs,
        'MEMBERSHIP_CONTEXT_STALE',
      );
      return 'DEFERRED';
    }
    if (resolution.status === 'AMBIGUOUS' || resolution.status === 'NOT_FOUND') {
      /**
       * ใช้ reason code ตรงตามที่ Customer 360 ตอบ แต่ไม่พยายามบอกมากกว่านั้น — การแยกว่า
       * "ไม่มีจริง" กับ "เป็นของ tenant อื่น" จะเปิดให้เดา existence ข้าม tenant ได้
       */
      await this.receipts.markReview(tenantId, claimed.id, resolution.reasonCode);
      return 'REVIEW';
    }
    if (resolution.status !== 'ELIGIBLE') {
      await this.receipts.applyNoOp(tenantId, claimed.id);
      return 'NOT_ELIGIBLE';
    }

    const matched = await this.definitions.findPublishedBySegmentTrigger(
      tenantId,
      claimed.segmentId,
    );
    if (matched.length === 0) {
      // ไม่มี journey ไหนสนใจ segment นี้ — head ต้องเลื่อนอยู่ดี ไม่งั้น revision ถัดไปค้าง
      await this.receipts.applyNoOp(tenantId, claimed.id);
      return 'NO_MATCH';
    }

    /**
     * survivor ที่ Customer 360 ตัดสินเท่านั้นที่ใช้ได้ ไม่ใช่ contactId ที่ติดมากับ event
     * — merge ทำให้สองค่านี้ต่างกัน และการใช้ค่าจาก event จะสร้าง enrollment ให้ contact
     * ที่ไม่มีอยู่แล้ว
     */
    const canonicalContactId = resolution.contactId;

    const scopes = await Promise.all(
      matched.map((definition) =>
        this.ports.teamContactScopeAuthorizer.authorize({
          tenantId: toTenantId(tenantId),
          teamId: toTeamId(definition.ownerTeamId),
          contactId: toContactId(canonicalContactId),
          permission: 'WORK',
          at,
        }),
      ),
    );

    if (scopes.some((scope) => scope.decision === 'DEFER')) {
      await this.receipts.markRetryableFailure(
        tenantId,
        claimed.id,
        this.retryDelayMs,
        'SCOPE_CONTEXT_STALE',
      );
      return 'DEFERRED';
    }

    /**
     * DENY คือ "ทีมนี้ทำงานกับ contact นี้ไม่ได้" ไม่ใช่การบล็อกทาง Governance — บันทึกเป็น
     * Governance BLOCK ไม่ได้เด็ดขาด (acceptance ของ #217) แค่ไม่สร้าง enrollment ให้ทีมนั้น
     */
    const allowed = matched.filter((_, index) => scopes[index]?.decision === 'ALLOW');
    if (allowed.length === 0) {
      await this.receipts.applyNoOp(tenantId, claimed.id);
      return 'DENIED';
    }

    const intents: SegmentEnrollmentIntentInput[] = allowed.map((definition) => ({
      journeyId: definition.journeyId,
      journeyVersion: definition.version,
      reasonMembershipRevision: resolution.membershipRevision,
      reasonDefinitionVersion: resolution.segmentDefinitionVersion,
      reasonDigest: resolution.stateDigest,
      ...(resolution.evidenceRef ? { reasonEvidenceRef: resolution.evidenceRef } : {}),
    }));

    await this.receipts.applyEnrollment(
      {
        tenantId,
        receiptId: claimed.id,
        entryId: claimed.entryId,
        canonicalContactId,
        intents,
        correlationId: claimed.correlationId,
        ...(claimed.causationId ? { causationId: claimed.causationId } : {}),
      },
      this.outboxEvent(canonicalContactId, claimed.segmentId, {
        kind: 'SEGMENT_ENTRY_ENROLLED',
        journeys: intents.map((intent) => ({
          journeyId: intent.journeyId,
          journeyVersion: intent.journeyVersion,
        })),
      }),
    );
    return 'ENROLLED';
  }

  /**
   * payload ของ outbox เก็บได้แค่ reference/version/digest เหมือน enrollment reason
   * — ไม่มีค่า attribute, ไม่มี identity ดิบ และไม่มีนิยาม segment
   */
  private outboxEvent(
    contactIdValue: string,
    segmentIdValue: string,
    body: Record<string, unknown>,
  ) {
    const payload = { contractVersion: 1, segmentId: segmentIdValue, ...body };
    return {
      eventType: 'journey.segment_entry.recorded',
      orderingKey: `${contactIdValue}:${segmentIdValue}`,
      payload,
      // hash ต้องคำนวณจาก payload จริงเสมอ ค่าที่สุ่มมาจะทำให้ integrity check ทั้งเส้นไร้ความหมาย
      payloadHash: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
    };
  }
}
