import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type DvOutboxState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  ReservationBindingError,
  actionKey as toActionKey,
  deliveryId as toDeliveryId,
  outcomeRef as toOutcomeRef,
  providerRequestKey as toProviderRequestKey,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactGovernancePort,
  type DeliveryEnqueueErrorCode,
  type DeliveryId,
  type DeliveryPort,
  type EnqueueDeliveryCommand,
  type EnqueueDeliveryResult,
  type NormalizedDeliveryOutcome,
  type ReservationSettlementView,
} from '@d-contact/cxa-contracts';

function canonicalHash(command: EnqueueDeliveryCommand): string {
  const canonical = JSON.stringify(
    Object.entries(command)
      .filter(
        ([key, value]) => key !== 'correlationId' && key !== 'causationId' && value !== undefined,
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Derive แบบ deterministic จาก (kind, tenantId, actionKey) แทน random เพื่อให้ retry
 * หลัง crash ระหว่างเรียก Governance กับ persist outbox ยังส่ง binding เดิมได้เสมอ —
 * ไม่ออก id ใหม่จาก retry ของ actionKey เดิมตามสัญญาของ DeliveryPort
 */
function derivedId(kind: string, tenantId: string, actionKey: string): string {
  return createHash('sha256').update(`${kind}:${tenantId}:${actionKey}`).digest('hex');
}

function queuedResult(row: {
  deliveryId: string;
  providerRequestKey: string;
}): EnqueueDeliveryResult {
  return {
    status: 'QUEUED',
    deliveryId: toDeliveryId(row.deliveryId),
    providerRequestKey: toProviderRequestKey(row.providerRequestKey),
  };
}

export class DeliveryOutboxNotFoundError extends Error {
  readonly code = 'DELIVERY_NOT_FOUND' as const;

  constructor(readonly deliveryId: string) {
    super(`ไม่พบ delivery ใน outbox: ${deliveryId}`);
    this.name = 'DeliveryOutboxNotFoundError';
  }
}

export interface SubmitDeliveryInput {
  tenantId: string;
  deliveryId: DeliveryId;
  correlationId: string;
}

export interface ReportDeliveryOutcomeInput {
  tenantId: string;
  deliveryId: DeliveryId;
  outcome: NormalizedDeliveryOutcome;
  /** Idempotency key ของ raw callback หนึ่งครั้ง — callback ซ้ำด้วยคีย์เดิมต้องไม่ settle ซ้ำ */
  providerCallbackId: string;
  occurredAt: string;
  correlationId: string;
}

export interface DeliveryTestAdapterOptions {
  id?: () => string;
}

/**
 * Owner: Channels/Dialer. Durable `TEST_ADAPTER` — ไม่มี provider credential, SDK
 * หรือ network I/O จริงที่ไหนในไฟล์นี้ (ดู `delivery-test-adapter.test.ts`) enqueue
 * ผ่าน `ContactGovernancePort.claimReservationForDelivery` แล้ว persist outbox row
 * เท่านั้นก่อนตอบ QUEUED; `submit`/`reportOutcome` เป็น convenience เพิ่มเติมนอก
 * `DeliveryPort` สำหรับ simulate submission barrier และ outcome callback ของ
 * provider จำลอง — caller (test/harness) เป็นผู้ขับ ไม่ใช่ traffic จริง
 */
export class DeliveryTestAdapter implements DeliveryPort {
  readonly adapterProfile = 'TEST_ADAPTER' as const;
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly governance: ContactGovernancePort,
    options: DeliveryTestAdapterOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  async enqueue(command: EnqueueDeliveryCommand): Promise<EnqueueDeliveryResult> {
    const hash = canonicalHash(command);

    return withTenantDatabaseTransaction(this.database, command.tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`dv-outbox:${command.tenantId}:${command.actionKey}`}))`,
      );

      const existing = await transaction.dvOutbox.findUnique({
        where: { tenantId_actionKey: { tenantId: command.tenantId, actionKey: command.actionKey } },
      });
      if (existing) {
        return existing.inputHash === hash
          ? queuedResult(existing)
          : { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
      }

      const mintedDeliveryId = toDeliveryId(
        derivedId('delivery', command.tenantId, command.actionKey),
      );
      const mintedProviderRequestKey = toProviderRequestKey(
        derivedId('provider-request', command.tenantId, command.actionKey),
      );

      let claimed: ReservationSettlementView;
      try {
        claimed = await this.governance.claimReservationForDelivery({
          tenantId: command.tenantId,
          correlationId: command.correlationId,
          reservationId: command.reservationId,
          actionKey: command.actionKey,
          deliveryId: mintedDeliveryId,
          contactId: command.contactId,
          identityId: command.identityId,
          channel: command.channel,
          purpose: command.purpose,
          senderIdentityId: command.senderIdentityId,
          leaseExpiresAt: command.leaseExpiresAt,
        });
      } catch (error) {
        if (!(error instanceof ReservationBindingError)) throw error;
        return { status: 'ERROR', code: error.code as DeliveryEnqueueErrorCode };
      }

      const created = await transaction.dvOutbox.create({
        data: {
          id: this.id(),
          tenantId: command.tenantId,
          source: command.source,
          actionKey: command.actionKey,
          inputHash: hash,
          reservationId: command.reservationId,
          deliveryId: mintedDeliveryId,
          providerRequestKey: mintedProviderRequestKey,
          leaseVersion: claimed.leaseVersion ?? 1,
          channel: command.channel,
          contactId: command.contactId,
          identityId: command.identityId,
          senderIdentityId: command.senderIdentityId,
          contentRef: command.contentRef,
          ...(command.causationId ? { causationId: command.causationId } : {}),
          correlationId: command.correlationId,
        },
      });
      return queuedResult(created);
    });
  }

  /** persist submission barrier ผ่าน Governance ก่อน ("ส่ง" จำลอง — ไม่มี I/O จริงใน TEST_ADAPTER) */
  async submit(input: SubmitDeliveryInput): Promise<ReservationSettlementView> {
    const outbox = await this.load(input.tenantId, input.deliveryId);
    const result = await this.governance.beginProviderSubmission({
      tenantId: toTenantId(input.tenantId),
      correlationId: input.correlationId,
      reservationId: toReservationId(outbox.reservationId),
      actionKey: toActionKey(outbox.actionKey),
      deliveryId: input.deliveryId,
      expectedLeaseVersion: outbox.leaseVersion,
      providerRequestKey: toProviderRequestKey(outbox.providerRequestKey),
    });
    await this.setState(input.tenantId, input.deliveryId, 'SUBMITTING');
    return result;
  }

  /** normalize outcome จำลองของ provider แล้วส่งกลับ Governance เป็น fact เดียว */
  async reportOutcome(input: ReportDeliveryOutcomeInput): Promise<ReservationSettlementView> {
    const outbox = await this.load(input.tenantId, input.deliveryId);
    const binding = {
      tenantId: toTenantId(input.tenantId),
      correlationId: input.correlationId,
      reservationId: toReservationId(outbox.reservationId),
      actionKey: toActionKey(outbox.actionKey),
      deliveryId: input.deliveryId,
      providerRequestKey: toProviderRequestKey(outbox.providerRequestKey),
    };

    if (input.outcome === 'DELIVERED' || input.outcome === 'DELIVERY_FAILED') {
      await this.governance.confirmProviderAcceptance(binding);
    }

    const derivedOutcomeRef = toOutcomeRef(
      derivedId('outcome', input.tenantId, `${input.deliveryId}:${input.providerCallbackId}`),
    );
    const settled = await this.governance.settleDelivery({
      ...binding,
      outcomeRef: derivedOutcomeRef,
      outcome: input.outcome,
      occurredAt: input.occurredAt,
    });
    if (settled.status === 'SETTLED') {
      await this.setState(input.tenantId, input.deliveryId, 'SETTLED', derivedOutcomeRef);
    }
    return settled;
  }

  private async load(tenantId: string, deliveryId: DeliveryId) {
    const read = async (transaction: Prisma.TransactionClient) =>
      transaction.dvOutbox.findUnique({ where: { tenantId_deliveryId: { tenantId, deliveryId } } });
    const outbox = await withTenantDatabaseTransaction(this.database, tenantId, read);
    if (!outbox) throw new DeliveryOutboxNotFoundError(deliveryId);
    return outbox;
  }

  private async setState(
    tenantId: string,
    deliveryId: DeliveryId,
    state: DvOutboxState,
    outcomeRef?: string,
  ): Promise<void> {
    await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dvOutbox.updateMany({
        where: { tenantId, deliveryId },
        data: { state, ...(outcomeRef ? { outcomeRef } : {}) },
      }),
    );
  }
}
