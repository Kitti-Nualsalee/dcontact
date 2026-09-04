import {
  Prisma,
  PrismaClient,
  withTenantDatabaseTransaction,
  type InteractionStateType,
} from '@d-contact/db';
import { KAFKA_TOPICS, type TelephonyCallEvent, type TelephonyCommand } from '@d-contact/shared';
import type { KafkaEventEnvelope } from '@d-contact/kafka';

type PublishedEvent = KafkaEventEnvelope<Record<string, unknown>>;

export interface InboundVoiceRouterDependencies {
  publish(topic: (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS], event: PublishedEvent): Promise<void>;
  eventId(): string;
  now(): string;
}

export interface InboundVoiceRoutingResult {
  interactionId: string;
  status: 'QUEUED' | 'ASSIGNED' | 'ACTIVE';
  agentId?: string;
}

interface AvailableAgent {
  id: string;
  extension: string;
}

export class InboundVoiceRouter {
  constructor(
    private readonly database: PrismaClient,
    private readonly dependencies: InboundVoiceRouterDependencies,
  ) {}

  async handle(event: KafkaEventEnvelope<TelephonyCallEvent>): Promise<InboundVoiceRoutingResult> {
    if (event.type === 'call.answered') return this.handleAnswered(event);
    if (event.type !== 'call.created') {
      throw new Error(`InboundVoiceRouter does not handle event type ${event.type}`);
    }
    if (event.orderingKey !== event.payload.callUuid) {
      throw new Error('telephony event orderingKey must equal callUuid');
    }

    const result = await withTenantDatabaseTransaction(this.database, event.tenantId, async (transaction) => {
      const existing = await transaction.interaction.findFirst({
        where: { tenantId: event.tenantId, externalId: event.payload.callUuid },
        select: { id: true, state: true, agentId: true },
      });
      if (existing) return this.resultFromInteraction(existing);

      const destination = await transaction.voiceDestination.findFirst({
        where: {
          tenantId: event.tenantId,
          destination: event.payload.destination,
          entryMode: 'DIRECT_QUEUE',
          isActive: true,
          queue: { isActive: true },
        },
        select: { queueId: true },
      });
      if (!destination) throw new Error('no active direct voice destination for inbound call');

      let interaction;
      try {
        interaction = await transaction.interaction.create({
          data: {
            tenantId: event.tenantId,
            channel: 'VOICE',
            direction: 'INBOUND',
            state: 'QUEUED',
            queueId: destination.queueId,
            externalId: event.payload.callUuid,
            metadata: {
              vendor: event.payload.vendor,
              caller: event.payload.caller,
              destination: event.payload.destination,
            },
          },
          select: { id: true, state: true, agentId: true, queueId: true },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          const concurrent = await transaction.interaction.findFirstOrThrow({
            where: { tenantId: event.tenantId, externalId: event.payload.callUuid },
            select: { id: true, state: true, agentId: true },
          });
          return this.resultFromInteraction(concurrent);
        }
        throw error;
      }

      await transaction.interactionEvent.createMany({
        data: [
          { tenantId: event.tenantId, interactionId: interaction.id, type: 'interaction.created', payload: {} },
          { tenantId: event.tenantId, interactionId: interaction.id, type: 'interaction.queued', payload: {} },
        ],
      });

      const agent = await transaction.$queryRaw<AvailableAgent[]>(Prisma.sql`
        SELECT u.id, u.extension
        FROM users u
        JOIN LATERAL (
          SELECT state
          FROM agent_state_logs states
          WHERE states.tenant_id = ${event.tenantId}::uuid AND states.user_id = u.id
          ORDER BY states.started_at DESC, states.id DESC
          LIMIT 1
        ) latest ON true
        WHERE u.tenant_id = ${event.tenantId}::uuid
          AND u.role = 'AGENT'
          AND u.is_active = true
          AND u.extension IS NOT NULL
          AND latest.state = 'AVAILABLE'
        ORDER BY u.id
        FOR UPDATE OF u SKIP LOCKED
        LIMIT 1
      `);
      const available = agent[0];
      if (!available) return { interactionId: interaction.id, status: 'QUEUED' as const };

      await transaction.agentStateLog.create({
        data: { tenantId: event.tenantId, userId: available.id, state: 'RESERVED', reason: interaction.id },
      });
      const assigned = await transaction.interaction.update({
        where: { id: interaction.id },
        data: { state: 'ASSIGNED', agentId: available.id, assignedAt: new Date(this.dependencies.now()) },
        select: { id: true, state: true, agentId: true, queueId: true },
      });
      await transaction.interactionEvent.create({
        data: {
          tenantId: event.tenantId,
          interactionId: assigned.id,
          type: 'interaction.assigned',
          payload: { agentId: available.id },
        },
      });
      return {
        interactionId: assigned.id,
        status: 'ASSIGNED' as const,
        agentId: available.id,
        queueId: assigned.queueId,
        agentExtension: available.extension,
      };
    });

    if (result.status === 'ASSIGNED' && 'agentExtension' in result) {
      await this.publishLifecycle(event, result.interactionId, result.agentId!, result.queueId);
      await this.dependencies.publish(KAFKA_TOPICS.AGENT_EVENTS, this.envelope(event, result.interactionId, 'routing.offered', {
        interactionId: result.interactionId,
        userId: result.agentId!,
        queueId: result.queueId,
      }));
      const command: TelephonyCommand = {
        callUuid: event.payload.callUuid,
        vendor: event.payload.vendor,
        type: 'call.bridge',
        agentExtension: result.agentExtension,
      };
      await this.dependencies.publish(KAFKA_TOPICS.TELEPHONY_COMMANDS, this.envelope(event, event.payload.callUuid, 'call.bridge', command));
    } else if (!('deduplicated' in result)) {
      await this.publishLifecycle(event, result.interactionId, undefined, undefined);
    }
    return { interactionId: result.interactionId, status: result.status, agentId: result.agentId };
  }

  private async handleAnswered(event: KafkaEventEnvelope<TelephonyCallEvent>): Promise<InboundVoiceRoutingResult> {
    const interaction = await withTenantDatabaseTransaction(this.database, event.tenantId, async (transaction) => {
      const existing = await transaction.interaction.findFirstOrThrow({
        where: { tenantId: event.tenantId, externalId: event.payload.callUuid },
        select: { id: true, state: true, agentId: true },
      });
      if (existing.state === 'ACTIVE') return existing;
      if (existing.state !== 'ASSIGNED' || !existing.agentId) {
        throw new Error('call.answered requires an assigned interaction');
      }
      const active = await transaction.interaction.update({
        where: { id: existing.id },
        data: { state: 'ACTIVE', answeredAt: new Date(this.dependencies.now()) },
        select: { id: true, state: true, agentId: true },
      });
      await transaction.agentStateLog.create({
        data: { tenantId: event.tenantId, userId: existing.agentId, state: 'BUSY', reason: existing.id },
      });
      await transaction.interactionEvent.create({
        data: {
          tenantId: event.tenantId,
          interactionId: existing.id,
          type: 'interaction.answered',
          payload: { agentId: existing.agentId },
        },
      });
      return active;
    });
    if (interaction.state === 'ACTIVE') {
      await this.dependencies.publish(
        KAFKA_TOPICS.INTERACTION_EVENTS,
        this.envelope(event, interaction.id, 'interaction.answered', {
          interactionId: interaction.id,
          channel: 'VOICE',
          state: 'ACTIVE',
          agentId: interaction.agentId!,
        }),
      );
    }
    return { interactionId: interaction.id, status: 'ACTIVE', agentId: interaction.agentId! };
  }

  private resultFromInteraction(interaction: { id: string; state: InteractionStateType; agentId: string | null }) {
    return {
      interactionId: interaction.id,
      status: interaction.state === 'ASSIGNED' ? ('ASSIGNED' as const) : ('QUEUED' as const),
      ...(interaction.agentId ? { agentId: interaction.agentId } : {}),
      deduplicated: true as const,
    };
  }

  private async publishLifecycle(
    input: KafkaEventEnvelope<TelephonyCallEvent>,
    interactionId: string,
    agentId?: string,
    queueId?: string | null,
  ) {
    for (const type of agentId
      ? ['interaction.created', 'interaction.queued', 'interaction.assigned']
      : ['interaction.created', 'interaction.queued']) {
      await this.dependencies.publish(KAFKA_TOPICS.INTERACTION_EVENTS, this.envelope(input, interactionId, type, {
        interactionId,
        channel: 'VOICE',
        state: type === 'interaction.assigned' ? 'ASSIGNED' : 'QUEUED',
        ...(queueId ? { queueId } : {}),
        ...(agentId ? { agentId } : {}),
      }));
    }
  }

  private envelope(
    input: KafkaEventEnvelope<TelephonyCallEvent>,
    orderingKey: string,
    type: string,
    payload: Record<string, unknown>,
  ): PublishedEvent {
    return {
      eventId: this.dependencies.eventId(),
      type,
      tenantId: input.tenantId,
      occurredAt: this.dependencies.now(),
      correlationId: input.correlationId,
      causationId: input.eventId,
      orderingKey,
      payload,
    };
  }
}
