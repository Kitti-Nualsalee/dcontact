import { randomUUID } from 'node:crypto';
import {
  type CgFactOutcome,
  type DlOutboxEntry,
  type DlVoiceOriginate,
  type Prisma,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import { OutboxRepository, type CreateOutboxEntryInput } from './outbox-repository.js';

export interface CreateVoiceOriginateInput {
  outbox: CreateOutboxEntryInput;
  interactionId: string;
  workSessionLeaseId: string;
  agentUserId: string;
  agentExtension: string;
  telephonyNodeId: string;
  targetIdentityId: string;
  originationUuid: string;
}

export interface CreatedVoiceOriginate<T> {
  voice: DlVoiceOriginate;
  result: T;
}

export interface VoiceOriginateDelivery {
  outbox: DlOutboxEntry;
  voice: DlVoiceOriginate;
}

/** E1.18 (#520): persistence only; ESL/provider I/O belongs to the next PR. */
export class VoiceOriginateRepository {
  private readonly outbox: OutboxRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly id: () => string = randomUUID,
  ) {
    this.outbox = new OutboxRepository(database, 'FREESWITCH_ORIGINATE');
  }

  findByActionKey(tenantId: string, actionKey: string) {
    return this.outbox.findByActionKey(tenantId, actionKey);
  }

  async findVoiceByActionKey(
    tenantId: string,
    actionKey: string,
  ): Promise<VoiceOriginateDelivery | null> {
    const outbox = await this.findByActionKey(tenantId, actionKey);
    return outbox ? this.findByDeliveryId(tenantId, outbox.deliveryId) : null;
  }

  async findByDeliveryId(
    tenantId: string,
    deliveryId: string,
  ): Promise<VoiceOriginateDelivery | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const outbox = await transaction.dlOutboxEntry.findFirst({
        where: { tenantId, deliveryId, adapter: 'FREESWITCH_ORIGINATE' },
      });
      if (!outbox) return null;
      const voice = await transaction.dlVoiceOriginate.findFirst({
        where: { tenantId, deliveryId },
      });
      return voice ? { outbox, voice } : null;
    });
  }

  async markReconciling(
    tenantId: string,
    deliveryId: string,
  ): Promise<VoiceOriginateDelivery | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.dlOutboxEntry.updateMany({
        where: {
          tenantId,
          deliveryId,
          adapter: 'FREESWITCH_ORIGINATE',
          state: { in: ['QUEUED', 'SUBMITTING', 'SUBMITTED'] },
        },
        data: { state: 'RECONCILING' },
      });
      await transaction.dlVoiceOriginate.updateMany({
        where: { tenantId, deliveryId, state: 'QUEUED' },
        data: { state: 'RECONCILING' },
      });
      const outbox = await transaction.dlOutboxEntry.findFirst({
        where: { tenantId, deliveryId, adapter: 'FREESWITCH_ORIGINATE' },
      });
      const voice = await transaction.dlVoiceOriginate.findFirst({
        where: { tenantId, deliveryId },
      });
      return outbox && voice ? { outbox, voice } : null;
    });
  }

  async cancelBeforeSubmit(tenantId: string, deliveryId: string): Promise<void> {
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.dlOutboxEntry.updateMany({
        where: { tenantId, deliveryId, adapter: 'FREESWITCH_ORIGINATE', state: 'QUEUED' },
        data: { state: 'SETTLED', settledAt: new Date() },
      });
      await transaction.dlVoiceOriginate.updateMany({
        where: { tenantId, deliveryId, state: 'QUEUED' },
        data: { state: 'SETTLED' },
      });
    });
  }

  async requestCancelAfterSubmit(
    tenantId: string,
    deliveryId: string,
  ): Promise<VoiceOriginateDelivery | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.dlOutboxEntry.updateMany({
        where: {
          tenantId,
          deliveryId,
          adapter: 'FREESWITCH_ORIGINATE',
          state: { in: ['SUBMITTING', 'SUBMITTED', 'RECONCILING'] },
        },
        data: { state: 'RECONCILING' },
      });
      await transaction.dlVoiceOriginate.updateMany({
        where: { tenantId, deliveryId, state: { in: ['QUEUED', 'RECONCILING'] } },
        data: { state: 'CANCEL_REQUESTED' },
      });
      const outbox = await transaction.dlOutboxEntry.findFirst({
        where: { tenantId, deliveryId, adapter: 'FREESWITCH_ORIGINATE' },
      });
      const voice = await transaction.dlVoiceOriginate.findFirst({
        where: { tenantId, deliveryId },
      });
      return outbox && voice ? { outbox, voice } : null;
    });
  }

  advanceOutbox(
    tenantId: string,
    deliveryId: string,
    expected: Parameters<OutboxRepository['advance']>[2],
    data: Parameters<OutboxRepository['advance']>[3],
  ) {
    return this.outbox.advance(tenantId, deliveryId, expected, data);
  }

  async settle(
    delivery: VoiceOriginateDelivery,
    input: { outcome: CgFactOutcome; outcomeRef: string; settledAt: Date },
  ): Promise<VoiceOriginateDelivery | null> {
    return withTenantDatabaseTransaction(
      this.database,
      delivery.outbox.tenantId,
      async (transaction) => {
        await transaction.dlOutboxEntry.updateMany({
          where: {
            tenantId: delivery.outbox.tenantId,
            deliveryId: delivery.outbox.deliveryId,
            adapter: 'FREESWITCH_ORIGINATE',
            state: { in: ['SUBMITTING', 'SUBMITTED', 'RECONCILING'] },
          },
          data: {
            state: 'SETTLED',
            outcome: input.outcome,
            outcomeRef: input.outcomeRef,
            settledAt: input.settledAt,
          },
        });
        await transaction.dlVoiceOriginate.updateMany({
          where: {
            tenantId: delivery.outbox.tenantId,
            deliveryId: delivery.outbox.deliveryId,
            state: { in: ['QUEUED', 'CANCEL_REQUESTED', 'RECONCILING'] },
          },
          data: { state: 'SETTLED', outcome: input.outcome, outcomeRef: input.outcomeRef },
        });
        const outbox = await transaction.dlOutboxEntry.findFirst({
          where: {
            tenantId: delivery.outbox.tenantId,
            deliveryId: delivery.outbox.deliveryId,
            adapter: 'FREESWITCH_ORIGINATE',
          },
        });
        const voice = await transaction.dlVoiceOriginate.findFirst({
          where: { tenantId: delivery.outbox.tenantId, deliveryId: delivery.outbox.deliveryId },
        });
        return outbox && voice ? { outbox, voice } : null;
      },
    );
  }

  async create(input: CreateVoiceOriginateInput): Promise<DlVoiceOriginate> {
    const created = await this.createWith(input, async () => undefined);
    return created.voice;
  }

  /**
   * Interaction และ voice extension ต้องอยู่ใน transaction เดียวกับ generic outbox
   * เพื่อไม่ให้ click-to-call ตอบ QUEUED แล้วเหลือแถวใดแถวหนึ่งกำพร้า.
   */
  async createWith<T>(
    input: CreateVoiceOriginateInput,
    beforeVoice: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<CreatedVoiceOriginate<T>> {
    if (input.outbox.channel !== 'VOICE') throw new Error('voice originate requires VOICE channel');
    const created = await this.outbox.createWith(input.outbox, async (transaction, entry) => {
      const result = await beforeVoice(transaction);
      const voice = await transaction.dlVoiceOriginate.create({
        data: {
          id: this.id(),
          tenantId: input.outbox.tenantId,
          deliveryId: entry.deliveryId,
          interactionId: input.interactionId,
          workSessionLeaseId: input.workSessionLeaseId,
          agentUserId: input.agentUserId,
          agentExtension: input.agentExtension,
          telephonyNodeId: input.telephonyNodeId,
          targetIdentityId: input.targetIdentityId,
          originationUuid: input.originationUuid,
        },
      });
      return { voice, result };
    });
    return created.result;
  }
}
