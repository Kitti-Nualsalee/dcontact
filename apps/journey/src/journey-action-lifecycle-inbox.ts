/** S1.5 — Journey-owned immutable inbox สำหรับ Delivery barrier lifecycle. */
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type {
  JourneyActionLifecyclePort,
  JourneyActionLifecycleRecord,
} from '@d-contact/cxa-contracts';

function bindingHash(input: JourneyActionLifecycleRecord): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        actionKey: input.actionKey,
        reservationId: input.reservationId,
        deliveryId: input.deliveryId,
        providerRequestKey: input.providerRequestKey,
        state: input.state,
        occurredAt: input.occurredAt,
        correlationId: input.correlationId,
      }),
    )
    .digest('hex');
}

/**
 * Rejects missing/conflicting binding and never infers a lifecycle transition.
 * Delivery retries the same eventId safely; a changed payload under the same id
 * is quarantined by throwing before any Journey action can advance.
 */
export class JourneyActionLifecycleInboxService implements JourneyActionLifecyclePort {
  constructor(private readonly database: PrismaClient) {}

  async record(input: JourneyActionLifecycleRecord): Promise<void> {
    const tenantId = input.tenantId;
    const hash = bindingHash(input);
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`journey-lifecycle:${tenantId}:${input.actionKey}`}))`,
      );
      const existing = await transaction.jrActionLifecycleInbox.findUnique({
        where: { tenantId_eventId: { tenantId, eventId: input.eventId } },
        select: { bindingHash: true },
      });
      if (existing) {
        if (existing.bindingHash !== hash) {
          throw new Error('Journey lifecycle eventId มี immutable binding ที่ขัดแย้งกัน');
        }
        return;
      }
      const action = await transaction.jrAction.findFirst({
        where: { tenantId, actionKey: input.actionKey, reservationId: input.reservationId },
        select: { id: true, realtimeState: true, deliveryId: true, providerRequestKey: true },
      });
      if (!action) throw new Error('Journey lifecycle ไม่พบ action/reservation binding');
      if (
        (action.deliveryId && action.deliveryId !== input.deliveryId) ||
        (action.providerRequestKey && action.providerRequestKey !== input.providerRequestKey)
      ) {
        throw new Error('Journey lifecycle delivery/provider binding ขัดแย้งกัน');
      }
      const expected =
        input.state === 'PRE_BARRIER'
          ? ['QUEUED', 'RESERVED', 'PRE_BARRIER']
          : input.state === 'POST_BARRIER'
            ? ['PRE_BARRIER']
            : ['POST_BARRIER'];
      if (!expected.includes(action.realtimeState)) {
        throw new Error(
          `Journey lifecycle transition ไม่ถูกต้องจาก ${action.realtimeState} ไป ${input.state}`,
        );
      }
      await transaction.jrAction.update({
        where: { id: action.id },
        data: {
          realtimeState: input.state,
          deliveryId: input.deliveryId,
          providerRequestKey: input.providerRequestKey,
        },
      });
      await transaction.jrActionLifecycleInbox.create({
        data: {
          id: randomUUID(),
          tenantId,
          eventId: input.eventId,
          actionKey: input.actionKey,
          reservationId: input.reservationId,
          deliveryId: input.deliveryId,
          providerRequestKey: input.providerRequestKey,
          state: input.state,
          occurredAt: new Date(input.occurredAt),
          correlationId: input.correlationId,
          bindingHash: hash,
        },
      });
    });
  }
}
