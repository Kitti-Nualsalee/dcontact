import { randomUUID } from 'node:crypto';
import type { DlVoiceOriginate, PrismaClient } from '@d-contact/db';
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

/** E1.18 (#520): persistence only; ESL/provider I/O belongs to the next PR. */
export class VoiceOriginateRepository {
  private readonly outbox: OutboxRepository;

  constructor(
    database: PrismaClient,
    private readonly id: () => string = randomUUID,
  ) {
    this.outbox = new OutboxRepository(database, 'FREESWITCH_ORIGINATE');
  }

  async create(input: CreateVoiceOriginateInput): Promise<DlVoiceOriginate> {
    if (input.outbox.channel !== 'VOICE') throw new Error('voice originate requires VOICE channel');
    const created = await this.outbox.createWith(input.outbox, (transaction, entry) =>
      transaction.dlVoiceOriginate.create({
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
      }),
    );
    return created.result;
  }
}
