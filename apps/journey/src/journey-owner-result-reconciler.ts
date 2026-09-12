/**
 * J2.8 — reconcile a Journey-owned action against the real owner's canonical
 * result via `queryAction` (pull model, per J2.1's `J2OwnerPort`), then apply
 * it through `JourneyOwnerActionRepository.applyResult` (J2.3) — idempotent,
 * terminal-precedence-respecting. This never writes owner state directly;
 * the owner remains the sole author of its own canonical result.
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@d-contact/db';
import {
  actionKey as toActionKey,
  tenantId as toTenantId,
  type J2CaseOwnerPort,
  type J2DialerOwnerPort,
  type J2OwnerResultPayloadV1,
  type J2OwnerResultStatus,
} from '@d-contact/cxa-contracts';
import {
  JourneyOwnerActionRepository,
  OwnerActionNotFoundError,
  type ApplyOwnerResultOutcome,
} from './journey-owner-action-repository.js';

export type ReconcileOutcome = ApplyOwnerResultOutcome | 'NO_RESULT_YET';

/** J2OwnerResultStatus จริงมีมากกว่าที่ JrOwnerResultKind แยกได้ — success ทุกชนิด
 * (CREATED/LINKED/REOPENED/ADMITTED/ALREADY_ADMITTED/SCHEDULED/ALREADY_SCHEDULED)
 * ยุบเป็น ACKNOWLEDGED เดียวเพราะ Journey สนใจแค่ "owner รับแล้ว" ไม่ใช่รายละเอียด
 * ภายในของ owner นั้น ๆ */
const STATUS_TO_RESULT_KIND: Record<
  J2OwnerResultStatus,
  'ACKNOWLEDGED' | 'REJECTED' | 'CANCELLED' | 'SUPERSEDED' | 'TOO_LATE'
> = {
  CREATED: 'ACKNOWLEDGED',
  LINKED: 'ACKNOWLEDGED',
  REOPENED: 'ACKNOWLEDGED',
  ADMITTED: 'ACKNOWLEDGED',
  ALREADY_ADMITTED: 'ACKNOWLEDGED',
  SCHEDULED: 'ACKNOWLEDGED',
  ALREADY_SCHEDULED: 'ACKNOWLEDGED',
  CANCELLED: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED',
  TOO_LATE: 'TOO_LATE',
  REJECTED: 'REJECTED',
};

/** hash เนื้อหาของผลเอง (ไม่ใช่ requestHash ของ command เดิม) เพื่อตรวจ conflict ของ
 * ผลที่มาซ้ำภายใต้ commandId เดียวกันแต่เนื้อหาต่าง */
function hashResult(result: J2OwnerResultPayloadV1): string {
  const canonical = JSON.stringify({
    status: result.status,
    code: result.code,
    category: result.category,
    reasonCode: result.reasonCode,
    ownerAggregate: result.ownerAggregate ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class JourneyOwnerResultReconciler {
  private readonly actions: JourneyOwnerActionRepository;

  constructor(
    database: PrismaClient,
    private readonly casePort: J2CaseOwnerPort,
    private readonly dialerPort: J2DialerOwnerPort,
  ) {
    this.actions = new JourneyOwnerActionRepository(database);
  }

  /**
   * query owner ด้วย actionKey/requestHash เดิมแล้ว apply ผลถ้ามี — เรียกซ้ำได้
   * ปลอดภัยเสมอ (idempotent); ไม่มีผลกลับมาไม่ใช่ error แค่ยังรอ (ACK_UNKNOWN
   * escalation เป็นการตัดสินใจของ caller เอง ไม่ใช่ที่นี่)
   */
  async reconcile(tenantId: string, actionKey: string): Promise<ReconcileOutcome> {
    const action = await this.actions.getAction(tenantId, actionKey);
    if (!action) throw new OwnerActionNotFoundError(actionKey);

    const port = action.kind === 'ENSURE_CASE' ? this.casePort : this.dialerPort;
    const result = await port.queryAction(toTenantId(tenantId), {
      contractVersion: 1,
      actionKey: toActionKey(actionKey),
      requestHash: action.requestHash,
    });
    if (!result) return 'NO_RESULT_YET';

    const applied = await this.actions.applyResult({
      tenantId,
      commandId: result.commandId,
      actionKey,
      resultKind: STATUS_TO_RESULT_KIND[result.status],
      resultHash: hashResult(result),
      correlationId: result.commandId,
      ...(result.ownerAggregate ? { ownerAggregateRef: result.ownerAggregate.id } : {}),
      ...(result.ownerAggregate ? { ownerAggregateVersion: result.ownerAggregate.version } : {}),
    });
    return applied.outcome;
  }
}
