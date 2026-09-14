/**
 * J2.9 follow-up — crash recovery ของ originate barrier.
 *
 * `DialerOriginateBarrier` เดินสอง transaction สั้น ๆ คือ claim (`-> ORIGINATING`)
 * แล้วค่อย settle (`-> CONSUMED/DEFERRED/SCHEDULED`) ถ้า process ตายระหว่างสองจังหวะนี้
 * target/callback จะค้างใน `ORIGINATING` ตลอดไป
 *
 * sweeper นี้เก็บกวาดเฉพาะแถวที่ `originateLeaseExpiresAt` หมดอายุแล้ว โดยยึดสัญญา
 * เดียวกับ `DeliveryTestAdapter.reconcileExpired` ของ C1: **ห้าม release reservation,
 * ห้าม refund และห้าม originate ซ้ำ** เพราะ ณ จุดที่ lease หมดเราไม่มีทางรู้ว่า provider
 * (TEST_ADAPTER) รับสายไปแล้วหรือยัง การเดาแล้วยิงซ้ำอาจกลายเป็นโทรหา contact สองครั้ง
 * ซึ่งละเมิด governance boundary ของ #124 — จึงย้ายไป `RECONCILING` ให้ CG3 primitive
 * หรือคนตัดสินแทน
 */
import { type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';

export type OriginateReconcileKind = 'campaign_target' | 'callback';

/** evidence สำหรับ J2-OB01: ไม่มี contactId/PII — มีแค่ identity ของ record กับเวลา */
export interface OriginateReconcileEvidence {
  kind: OriginateReconcileKind;
  recordId: string;
  leaseExpiredAt: string;
  reconciledAt: string;
  correlationId: string;
}

export interface DialerOriginateReconcilerOptions {
  now?: () => Date;
  /** กันรอบ sweep เดียวกวาดทั้ง tenant จนล็อกยาว */
  batchSize?: number;
}

export class DialerOriginateReconciler {
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(
    private readonly database: PrismaClient,
    options: DialerOriginateReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? 100;
  }

  /**
   * ย้ายทุกแถวที่ค้าง `ORIGINATING` จน lease หมดไปเป็น `RECONCILING`
   *
   * idempotent โดยโครงสร้าง: เงื่อนไข update บังคับ `state: 'ORIGINATING'` เสมอ รอบที่สอง
   * จึงไม่เจออะไรและคืน array ว่าง ไม่ใช่การ settle ซ้ำ
   */
  async reconcileExpired(
    tenantId: string,
    correlationId: string,
  ): Promise<OriginateReconcileEvidence[]> {
    const deadline = this.now();
    const evidence: OriginateReconcileEvidence[] = [];

    const targets = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obCampaignTarget.findMany({
        where: {
          tenantId,
          state: 'ORIGINATING',
          originateLeaseExpiresAt: { not: null, lte: deadline },
        },
        orderBy: { originateLeaseExpiresAt: 'asc' },
        take: this.batchSize,
      }),
    );
    for (const target of targets) {
      const moved = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.obCampaignTarget.updateMany({
          where: { tenantId, id: target.id, state: 'ORIGINATING', version: target.version },
          data: { state: 'RECONCILING', originateLeaseExpiresAt: null, version: { increment: 1 } },
        }),
      );
      if (moved.count === 0) continue; // แข่งกับ settle ที่มาถึงก่อน — ปล่อยให้ settle ชนะ
      evidence.push({
        kind: 'campaign_target',
        recordId: target.id,
        leaseExpiredAt: target.originateLeaseExpiresAt!.toISOString(),
        reconciledAt: deadline.toISOString(),
        correlationId,
      });
    }

    const callbacks = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obCallback.findMany({
        where: {
          tenantId,
          state: 'ORIGINATING',
          originateLeaseExpiresAt: { not: null, lte: deadline },
        },
        orderBy: { originateLeaseExpiresAt: 'asc' },
        take: this.batchSize,
      }),
    );
    for (const callback of callbacks) {
      const moved = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.obCallback.updateMany({
          where: { tenantId, id: callback.id, state: 'ORIGINATING', version: callback.version },
          data: { state: 'RECONCILING', originateLeaseExpiresAt: null, version: { increment: 1 } },
        }),
      );
      if (moved.count === 0) continue;
      evidence.push({
        kind: 'callback',
        recordId: callback.id,
        leaseExpiredAt: callback.originateLeaseExpiresAt!.toISOString(),
        reconciledAt: deadline.toISOString(),
        correlationId,
      });
    }

    return evidence;
  }
}
