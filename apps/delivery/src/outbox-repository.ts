/**
 * Owner: Channels/Dialer — durable ownership ของ outbox
 *
 * ทุก write ผ่าน `withTenantDatabaseTransaction` เพื่อให้ RLS ของ `dl_outbox_entries`
 * ทำงานจริงกับ application role และไม่มี query ไหนอ่านข้าม tenant ได้
 * repository ไม่รู้จัก Governance หรือ transport — มันเก็บสถานะอย่างเดียว
 *
 * Mixed-version guard (S2.1 #365): repository หนึ่งตัวผูกกับ adapter เดียว ทุก read/claim/advance
 * ที่ทำงานกับ delivery กรองด้วย adapter นั้น worker ของ TEST_ADAPTER จึงไม่เคยหยิบแถว
 * LINE_MESSAGING_API ไป submit/reconcile และกลับกัน ยกเว้น `findByActionKey` ที่ต้องเห็นทุก
 * adapter เพราะ `(tenant_id, action_key)` เป็น idempotency identity ร่วม — ผู้เรียกต้องปฏิเสธ
 * แถวของ adapter อื่นเอง
 */
import {
  Prisma,
  type CgFactOutcome,
  type DlDeliveryAdapter,
  type DlDeliveryState,
  type DlOutboxEntry,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { ContactChannel } from '@d-contact/cxa-contracts';

export interface CreateOutboxEntryInput {
  id: string;
  tenantId: string;
  actionKey: string;
  reservationId: string;
  deliveryId: string;
  providerRequestKey: string;
  channel: ContactChannel;
  contactId: string;
  identityId?: string;
  purpose: string;
  source: string;
  senderIdentityId: string;
  contentRef: string;
  inputHash: string;
  leaseVersion: number;
  leaseExpiresAt: Date;
  correlationId: string;
  causationId?: string;
}

export class OutboxEntryAlreadyExistsError extends Error {
  readonly code = 'OUTBOX_ENTRY_ALREADY_EXISTS';

  constructor(readonly actionKey: string) {
    super(`มี outbox entry ของ actionKey ${actionKey} อยู่แล้ว`);
    this.name = 'OutboxEntryAlreadyExistsError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class OutboxRepository {
  constructor(
    private readonly database: PrismaClient,
    readonly adapter: DlDeliveryAdapter = 'TEST_ADAPTER',
  ) {}

  /** ไม่กรอง adapter โดยตั้งใจ — ดูหมายเหตุ mixed-version guard ด้านบน */
  findByActionKey(tenantId: string, actionKey: string): Promise<DlOutboxEntry | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlOutboxEntry.findFirst({ where: { tenantId, actionKey } }),
    );
  }

  findByDeliveryId(tenantId: string, deliveryId: string): Promise<DlOutboxEntry | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlOutboxEntry.findFirst({
        where: { tenantId, deliveryId, adapter: this.adapter },
      }),
    );
  }

  /**
   * insert เดียวที่ arbitrate การแข่งกันของ enqueue พร้อมกัน: unique index
   * `(tenant_id, action_key)` เป็นผู้ตัดสิน ไม่ใช่การอ่านก่อนเขียน ผู้แพ้จึงรู้ตัว
   * จาก P2002 แทนที่จะเขียนทับ delivery ของผู้ชนะ
   */
  async create(input: CreateOutboxEntryInput): Promise<DlOutboxEntry> {
    try {
      return await withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
        transaction.dlOutboxEntry.create({
          data: {
            id: input.id,
            tenantId: input.tenantId,
            actionKey: input.actionKey,
            reservationId: input.reservationId,
            deliveryId: input.deliveryId,
            providerRequestKey: input.providerRequestKey,
            adapter: this.adapter,
            channel: input.channel,
            contactId: input.contactId,
            ...(input.identityId ? { identityId: input.identityId } : {}),
            purpose: input.purpose,
            source: input.source,
            senderIdentityId: input.senderIdentityId,
            contentRef: input.contentRef,
            inputHash: input.inputHash,
            state: 'QUEUED',
            leaseVersion: input.leaseVersion,
            leaseExpiresAt: input.leaseExpiresAt,
            correlationId: input.correlationId,
            ...(input.causationId ? { causationId: input.causationId } : {}),
          },
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new OutboxEntryAlreadyExistsError(input.actionKey);
      throw error;
    }
  }

  /**
   * เลื่อน state แบบมีเงื่อนไข: `expected` คือ state ที่ผู้เรียกอ่านมา ถ้าแถวขยับไป
   * แล้วโดย worker อื่น update จะไม่โดนแถวไหนเลยและคืน null ให้ผู้เรียกอ่านใหม่
   */
  async advance(
    tenantId: string,
    deliveryId: string,
    expected: DlDeliveryState[],
    data: {
      state: DlDeliveryState;
      submittedAt?: Date;
      settledAt?: Date;
      outcome?: CgFactOutcome;
      outcomeRef?: string;
    },
  ): Promise<DlOutboxEntry | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlOutboxEntry.updateMany({
        where: { tenantId, deliveryId, adapter: this.adapter, state: { in: expected } },
        data,
      });
      if (updated.count === 0) return null;
      return transaction.dlOutboxEntry.findFirst({
        where: { tenantId, deliveryId, adapter: this.adapter },
      });
    });
  }

  /** งานที่ผ่าน submission barrier แล้วแต่ lease หมด — ต้อง reconcile ห้ามส่งซ้ำ */
  findReconcilable(tenantId: string, notAfter: Date): Promise<DlOutboxEntry[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlOutboxEntry.findMany({
        where: {
          tenantId,
          adapter: this.adapter,
          state: { in: ['SUBMITTING', 'SUBMITTED'] },
          leaseExpiresAt: { lte: notAfter },
        },
        orderBy: { leaseExpiresAt: 'asc' },
      }),
    );
  }
}
