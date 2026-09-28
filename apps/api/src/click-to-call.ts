/**
 * Owner: Integrations — click-to-call ของ dphone ที่ถูกฝัง (E1.14 #488)
 *
 * Authority: E1.6 #462 ข้อ 3, 5; คำตัดสิน decision gap ที่ #464 (2026-09-28)
 *
 * - host แค่กรอกเบอร์ agent ต้องกดโทรเอง — endpoint นี้ถูกเรียกเมื่อ agent กดโทรใน dphone เท่านั้น
 * - origin มาจาก lease `embedded` ที่ยัง current; contact resolve จากเบอร์ฝั่ง server (ไม่เชื่อ `contactId` ของ host)
 * - `authorizeAndReserve()` purpose `SERVICE` channel `VOICE`; BLOCK/DEFER/REVIEW → ไม่โทรออก
 * - ALLOW → ยังไม่โทรจริงจนกว่า Voice Delivery Gate (E1.18 #520, ตาม #57) จะเปิด: ปล่อย reservation ทันที
 *   แล้วตอบ `unavailable` + `OUTBOUND_VOICE_NOT_ENABLED`
 * - ตอบ host โดยไม่มี PII; rate limit ต่อ agent; audit ทุกครั้ง (ไม่เก็บเบอร์)
 */
import { randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { CallResultMessage } from '@d-contact/dphone-embed';
import type {
  AuthorizationOutcome,
  AuthorizeAndReserveInput,
  ReservationCommand,
} from '@d-contact/cxa-contracts';

export const CLICK_TO_CALL_PURPOSE = 'SERVICE';
export const CLICK_TO_CALL_SOURCE = 'DPHONE_CLICK_TO_CALL';
export const OUTBOUND_VOICE_NOT_ENABLED = 'OUTBOUND_VOICE_NOT_ENABLED';

export interface ClickToCallGovernance {
  authorizeAndReserve(
    tenantId: string,
    input: AuthorizeAndReserveInput,
  ): Promise<AuthorizationOutcome>;
  changeReservationState(
    tenantId: string,
    reservationId: string,
    command: ReservationCommand,
  ): Promise<unknown>;
}

export interface ClickToCallActor {
  tenantId: string;
  userId: string;
}

export type ClickToCallOutcome =
  { status: 'result'; message: CallResultMessage; hostOrigin: string } | { status: 'not_found' };

/** เบอร์สำหรับเทียบ identity: ตัดตัวคั่นทิ้ง คงตัวเลขและ `+` นำหน้า */
export function normalizeDialNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\+?[0-9][0-9 ()-]{1,30}$/.test(trimmed)) return null;
  const digits = trimmed.replace(/[^0-9]/g, '');
  return digits.length >= 3 && digits.length <= 20 ? digits : null;
}

export class ClickToCallService {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly database: PrismaClient,
    private readonly deps: {
      hostOriginOfLease(actor: ClickToCallActor, leaseId: string): Promise<string | null>;
      governance: ClickToCallGovernance;
      now?: () => Date;
      id?: () => string;
      /** ต่อ agent — ค่าเริ่มต้น 10 ครั้ง / 60 วินาที */
      rate?: { limit: number; windowMs: number };
    },
  ) {
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? randomUUID;
  }

  async request(
    actor: ClickToCallActor,
    input: { leaseId: string; requestId: string; number: string },
    correlationId: string,
  ): Promise<ClickToCallOutcome> {
    const hostOrigin = await this.deps.hostOriginOfLease(actor, input.leaseId);
    if (!hostOrigin) return { status: 'not_found' };
    // actionKey ผูกกับ lease + requestId ของ host: ส่งซ้ำได้ผลเดิม (idempotent ที่ Governance)
    const actionKey = `dphone-click-to-call:${input.leaseId}:${input.requestId}`;
    const audit = { actor, input, hostOrigin, actionKey, correlationId };

    if (!this.allow(actor)) {
      const message = result(input.requestId, 'rate_limited', true, 'RATE_LIMITED');
      await this.audit(audit, { message, contactId: null, outcome: null });
      return { status: 'result', message, hostOrigin };
    }

    const number = normalizeDialNumber(input.number);
    if (!number) {
      const message = result(input.requestId, 'blocked', true, 'INVALID_NUMBER');
      await this.audit(audit, { message, contactId: null, outcome: null });
      return { status: 'result', message, hostOrigin };
    }

    const contactId = await this.resolveContact(actor.tenantId, number);
    const outcome = await this.deps.governance.authorizeAndReserve(actor.tenantId, {
      channel: 'VOICE',
      purpose: CLICK_TO_CALL_PURPOSE,
      source: CLICK_TO_CALL_SOURCE,
      sourceId: input.leaseId,
      actionKey,
      policyVersion: 1,
      ...(contactId ? { contactId } : { identityResolution: 'NOT_FOUND' as const }),
    });

    let message: CallResultMessage;
    if (outcome.decision === 'ALLOW') {
      // ยังไม่มี Voice Delivery Gate — ห้ามแตะ provider; คืนสิทธิ์ทันทีไม่ให้ quota ค้าง
      if (outcome.reservationId) {
        await this.deps.governance.changeReservationState(
          actor.tenantId,
          outcome.reservationId,
          'RELEASE',
        );
      }
      message = result(input.requestId, 'unavailable', false, OUTBOUND_VOICE_NOT_ENABLED);
    } else {
      message = result(input.requestId, 'blocked', true, outcome.reasonCode);
      if (outcome.decision === 'DEFER' && outcome.nextEligibleAt) {
        message.retryAt = outcome.nextEligibleAt;
      }
    }
    message.decisionId = outcome.decisionId;
    await this.audit(audit, { message, contactId, outcome });
    return { status: 'result', message, hostOrigin };
  }

  private allow(actor: ClickToCallActor): boolean {
    const { limit, windowMs } = this.deps.rate ?? { limit: 10, windowMs: 60_000 };
    const key = `${actor.tenantId}:${actor.userId}`;
    const now = this.now().getTime();
    const times = (this.recent.get(key) ?? []).filter((time) => now - time < windowMs);
    if (times.length >= limit) {
      this.recent.set(key, times);
      return false;
    }
    times.push(now);
    this.recent.set(key, times);
    return true;
  }

  /** contact เดียวที่มี identity PHONE ตรงกับเบอร์ — ไม่พบหรือพบหลายราย = ไม่ระบุ (NOT_FOUND) */
  private resolveContact(tenantId: string, digits: string): Promise<string | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ contact_id: string }[]>(Prisma.sql`
        SELECT DISTINCT contact_id::text AS contact_id FROM contact_identities
        WHERE tenant_id = ${tenantId}::uuid AND type = 'PHONE'
          AND regexp_replace(value, '[^0-9]', '', 'g') = ${digits}
        LIMIT 2`);
      return rows.length === 1 ? rows[0]!.contact_id : null;
    });
  }

  private async audit(
    context: {
      actor: ClickToCallActor;
      input: { leaseId: string; requestId: string };
      hostOrigin: string;
      actionKey: string;
      correlationId: string;
    },
    detail: {
      message: CallResultMessage;
      contactId: string | null;
      outcome: AuthorizationOutcome | null;
    },
  ) {
    await withTenantDatabaseTransaction(this.database, context.actor.tenantId, (tx) =>
      tx.dphoneClickToCallAuditEvent.create({
        data: {
          id: this.id(),
          tenantId: context.actor.tenantId,
          actorUserId: context.actor.userId,
          leaseId: context.input.leaseId,
          hostOrigin: context.hostOrigin,
          requestId: context.input.requestId,
          actionKey: context.actionKey,
          contactId: detail.contactId,
          decisionId: detail.outcome?.decisionId ?? null,
          decision: detail.outcome?.decision ?? null,
          reasonCode: detail.message.reasonCode ?? 'UNKNOWN',
          outcome: detail.message.status,
          correlationId: context.correlationId,
          occurredAt: this.now(),
        },
      }),
    );
  }
}

function result(
  requestId: string,
  status: CallResultMessage['status'],
  blocked: boolean,
  reasonCode: string,
): CallResultMessage {
  return { v: 1, type: 'dphone.call.result', requestId, status, blocked, reasonCode };
}
