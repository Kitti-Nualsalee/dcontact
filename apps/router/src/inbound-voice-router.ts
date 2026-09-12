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
  publish(
    topic: (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS],
    event: PublishedEvent,
  ): Promise<void>;
  eventId(): string;
  now(): string;
}

export interface InboundVoiceRoutingResult {
  interactionId: string;
  status: InteractionStateType;
  agentId?: string;
}

export interface CompleteWrapUpCommand {
  tenantId: string;
  interactionId: string;
  agentId: string;
  code: string;
}

export interface DeclineOfferCommand {
  tenantId: string;
  interactionId: string;
  agentId: string;
}

interface AvailableAgent {
  id: string;
  extension: string;
}

interface QueuePolicySource {
  offerTimeoutSec: number | null;
  offerTimeoutAction: 'IMMEDIATE_REQUEUE' | 'COOLDOWN_REQUEUE' | 'ABANDON' | null;
  offerCooldownSec: number | null;
  maxWaitSec: number | null;
  maxWaitAction: 'WAIT' | 'CALLBACK' | 'VOICEMAIL' | null;
  routingStrategy: 'LONGEST_AVAILABLE_IDLE' | 'LONGEST_SINCE_LAST_INTERACTION' | 'ROUND_ROBIN';
  tenant: {
    defaultOfferTimeoutSec: number;
    defaultOfferTimeoutAction: 'IMMEDIATE_REQUEUE' | 'COOLDOWN_REQUEUE' | 'ABANDON';
    defaultOfferCooldownSec: number;
    defaultMaxWaitSec: number | null;
    defaultMaxWaitAction: 'WAIT' | 'CALLBACK' | 'VOICEMAIL';
  };
}

interface DueOfferOutcome {
  interactionId: string;
  tenantId: string;
  queueId: string | null;
  agentId?: string;
  agentExtension?: string;
  callUuid: string;
  vendor: TelephonyCallEvent['vendor'];
  telephonyNodeId: string;
  timedOut: boolean;
  requeued: boolean;
  abandoned?: boolean;
  reason?: string;
}

interface IvrConfiguration {
  prompt: string;
  inputTimeoutSec: number;
  voiceRoutes: Record<string, string>;
  dtmfRoutes: Record<string, string>;
}

interface IvrCollectRequest {
  interactionId: string;
  inputMode: 'VOICE' | 'DTMF';
  prompt: string;
  timeoutSec: number;
}

type TelephonyCallMetadata = Pick<
  TelephonyCallEvent,
  'vendor' | 'telephonyNodeId' | 'caller' | 'destination'
>;

export class InboundVoiceRouter {
  private readonly queuePolicySelection = {
    offerTimeoutSec: true,
    offerTimeoutAction: true,
    offerCooldownSec: true,
    maxWaitSec: true,
    maxWaitAction: true,
    routingStrategy: true,
    tenant: {
      select: {
        defaultOfferTimeoutSec: true,
        defaultOfferTimeoutAction: true,
        defaultOfferCooldownSec: true,
        defaultMaxWaitSec: true,
        defaultMaxWaitAction: true,
      },
    },
  } as const;

  constructor(
    private readonly database: PrismaClient,
    private readonly dependencies: InboundVoiceRouterDependencies,
  ) {}

  async handle(event: KafkaEventEnvelope<TelephonyCallEvent>): Promise<InboundVoiceRoutingResult> {
    if (event.type === 'call.answered') return this.handleAnswered(event);
    if (event.type === 'call.hangup') return this.handleHangup(event);
    if (event.type === 'call.input') return this.handleIvrInput(event);
    if (event.type !== 'call.created') {
      throw new Error(`InboundVoiceRouter does not handle event type ${event.type}`);
    }
    if (event.orderingKey !== event.payload.callUuid) {
      throw new Error('telephony event orderingKey must equal callUuid');
    }

    const duplicateInteraction = new Error('concurrent inbound interaction create');
    const result = await (async () => {
      try {
        return await withTenantDatabaseTransaction(
          this.database,
          event.tenantId,
          async (transaction) => {
            const existing = await transaction.interaction.findFirst({
              where: { tenantId: event.tenantId, externalId: event.payload.callUuid },
              select: { id: true, state: true, agentId: true },
            });
            if (existing) return this.resultFromInteraction(existing);

            const destination = await transaction.voiceDestination.findFirst({
              where: {
                tenantId: event.tenantId,
                destination: event.payload.destination,
                isActive: true,
                queue: { isActive: true },
              },
              select: {
                id: true,
                entryMode: true,
                queueId: true,
                ivrConfig: true,
                queue: { select: this.queuePolicySelection },
              },
            });
            if (!destination)
              throw new Error('no active direct voice destination for inbound call');

            let interaction;
            try {
              interaction = await transaction.interaction.create({
                data: {
                  tenantId: event.tenantId,
                  channel: 'VOICE',
                  direction: 'INBOUND',
                  state: 'QUEUED',
                  queueId: destination.entryMode === 'DIRECT_QUEUE' ? destination.queueId : null,
                  ...(destination.entryMode === 'IVR'
                    ? {
                        ivrDestinationId: destination.id,
                        ivrStage: 'VOICE' as const,
                        ivrInputExpiresAt: this.ivrInputExpiresAt(
                          this.ivrConfiguration(destination.ivrConfig).inputTimeoutSec,
                        ),
                      }
                    : {}),
                  externalId: event.payload.callUuid,
                  metadata: {
                    vendor: event.payload.vendor,
                    telephonyNodeId: event.payload.telephonyNodeId,
                    caller: event.payload.caller,
                    destination: event.payload.destination,
                  },
                },
                select: { id: true, state: true, agentId: true, queueId: true },
              });
            } catch (error) {
              if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                // PostgreSQL aborts the current transaction after a unique violation.
                // Read the concurrent winner in a fresh transaction below instead.
                throw duplicateInteraction;
              }
              throw error;
            }

            await transaction.interactionEvent.createMany({
              data: [
                {
                  tenantId: event.tenantId,
                  interactionId: interaction.id,
                  type: 'interaction.created',
                  payload: {},
                },
                {
                  tenantId: event.tenantId,
                  interactionId: interaction.id,
                  type: 'interaction.queued',
                  payload: {},
                },
              ],
            });

            if (destination.entryMode === 'IVR') {
              const configuration = this.ivrConfiguration(destination.ivrConfig);
              return {
                interactionId: interaction.id,
                status: 'QUEUED' as const,
                ivrCollect: {
                  interactionId: interaction.id,
                  inputMode: 'VOICE' as const,
                  prompt: configuration.prompt,
                  timeoutSec: configuration.inputTimeoutSec,
                },
              };
            }

            const policy = this.resolveQueuePolicy(destination.queue);
            const available = await this.findAvailableAgent(
              transaction,
              event.tenantId,
              destination.queueId,
              policy.routingStrategy,
            );
            if (!available) return { interactionId: interaction.id, status: 'QUEUED' as const };

            await transaction.agentStateLog.create({
              data: {
                tenantId: event.tenantId,
                userId: available.id,
                state: 'RESERVED',
                reason: interaction.id,
              },
            });
            const assigned = await transaction.interaction.update({
              where: { id: interaction.id },
              data: {
                state: 'ASSIGNED',
                agentId: available.id,
                assignedAt: new Date(this.dependencies.now()),
                offerExpiresAt: this.offerExpiresAt(policy.offerTimeoutSec),
              },
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
          },
        );
      } catch (error) {
        if (error !== duplicateInteraction) {
          throw error;
        }
        return withTenantDatabaseTransaction(this.database, event.tenantId, async (transaction) => {
          const concurrent = await transaction.interaction.findFirstOrThrow({
            where: { tenantId: event.tenantId, externalId: event.payload.callUuid },
            select: { id: true, state: true, agentId: true },
          });
          return this.resultFromInteraction(concurrent);
        });
      }
    })();

    if ('ivrCollect' in result) {
      await this.publishLifecycle(event, result.interactionId, undefined, undefined);
      await this.publishCollect(event, result.ivrCollect!);
    } else if (result.status === 'ASSIGNED' && 'agentExtension' in result) {
      await this.publishLifecycle(event, result.interactionId, result.agentId!, result.queueId);
      await this.dependencies.publish(
        KAFKA_TOPICS.AGENT_EVENTS,
        this.envelope(event, result.interactionId, 'routing.offered', {
          interactionId: result.interactionId,
          userId: result.agentId!,
          queueId: result.queueId,
        }),
      );
      const command: TelephonyCommand = {
        callUuid: event.payload.callUuid,
        vendor: event.payload.vendor,
        telephonyNodeId: event.payload.telephonyNodeId,
        type: 'call.bridge',
        agentExtension: result.agentExtension,
      };
      await this.dependencies.publish(
        KAFKA_TOPICS.TELEPHONY_COMMANDS,
        this.envelope(event, event.payload.callUuid, 'call.bridge', command),
      );
    } else if (!('deduplicated' in result)) {
      await this.publishLifecycle(event, result.interactionId, undefined, undefined);
    }
    return { interactionId: result.interactionId, status: result.status, agentId: result.agentId };
  }

  async processDue(): Promise<void> {
    const now = new Date(this.dependencies.now());
    const tenants = await this.database.tenant.findMany({ select: { id: true } });
    const outcomes: DueOfferOutcome[] = [];
    const ivrTimeouts: KafkaEventEnvelope<TelephonyCallEvent>[] = [];
    for (const tenant of tenants) {
      const tenantOutcomes = await withTenantDatabaseTransaction(
        this.database,
        tenant.id,
        async (transaction) => {
          const dueIvrInputs = await transaction.interaction.findMany({
            where: {
              tenantId: tenant.id,
              channel: 'VOICE',
              state: 'QUEUED',
              ivrStage: { not: null },
              ivrInputExpiresAt: { lte: now },
            },
            select: { id: true, externalId: true, metadata: true },
          });
          for (const dueIvrInput of dueIvrInputs) {
            if (!dueIvrInput.externalId) continue;
            const metadata = this.telephonyCallMetadata(dueIvrInput.metadata);
            ivrTimeouts.push({
              eventId: this.dependencies.eventId(),
              type: 'call.input',
              tenantId: tenant.id,
              occurredAt: this.dependencies.now(),
              correlationId: dueIvrInput.externalId,
              orderingKey: dueIvrInput.externalId,
              payload: {
                ...metadata,
                callUuid: dueIvrInput.externalId,
                inputMode: 'TIMEOUT',
              },
            });
          }
          const dueOffers = await transaction.interaction.findMany({
            where: {
              tenantId: tenant.id,
              channel: 'VOICE',
              state: 'ASSIGNED',
              offerExpiresAt: { lte: now },
            },
            select: {
              id: true,
              queueId: true,
              agentId: true,
              externalId: true,
              metadata: true,
              queue: { select: this.queuePolicySelection },
            },
          });
          const result: DueOfferOutcome[] = [];
          for (const dueOffer of dueOffers) {
            if (!dueOffer.agentId || !dueOffer.externalId || !dueOffer.queue || !dueOffer.queueId) {
              continue;
            }
            const metadata = this.telephonyMetadata(dueOffer.metadata);
            const policy = this.resolveQueuePolicy(dueOffer.queue);
            if (policy.offerTimeoutAction === 'ABANDON') {
              const abandoned = await transaction.interaction.updateMany({
                where: {
                  id: dueOffer.id,
                  tenantId: tenant.id,
                  state: 'ASSIGNED',
                  offerExpiresAt: { lte: now },
                },
                data: {
                  state: 'ABANDONED',
                  endedAt: now,
                  offerExpiresAt: null,
                },
              });
              if (abandoned.count === 0) continue;
              await transaction.agentStateLog.create({
                data: {
                  tenantId: tenant.id,
                  userId: dueOffer.agentId,
                  state: 'AVAILABLE',
                  reason: dueOffer.id,
                },
              });
              await transaction.interactionEvent.createMany({
                data: [
                  {
                    tenantId: tenant.id,
                    interactionId: dueOffer.id,
                    type: 'interaction.offer_timed_out',
                    payload: { agentId: dueOffer.agentId },
                  },
                  {
                    tenantId: tenant.id,
                    interactionId: dueOffer.id,
                    type: 'interaction.abandoned',
                    payload: { reason: 'offer_timeout' },
                  },
                ],
              });
              result.push({
                interactionId: dueOffer.id,
                tenantId: tenant.id,
                queueId: dueOffer.queueId,
                callUuid: dueOffer.externalId,
                ...metadata,
                timedOut: true,
                requeued: false,
                abandoned: true,
              });
              continue;
            }
            const claimed = await transaction.interaction.updateMany({
              where: {
                id: dueOffer.id,
                tenantId: tenant.id,
                state: 'ASSIGNED',
                offerExpiresAt: { lte: now },
              },
              data:
                policy.offerTimeoutAction === 'COOLDOWN_REQUEUE'
                  ? {
                      state: 'QUEUED',
                      agentId: null,
                      offerExpiresAt: null,
                      requeueAt: this.requeueAt(policy.offerCooldownSec),
                    }
                  : { state: 'QUEUED', agentId: null, offerExpiresAt: null, requeueAt: null },
            });
            if (claimed.count === 0) continue;
            if (policy.offerTimeoutAction === 'COOLDOWN_REQUEUE') {
              await transaction.agentStateLog.create({
                data: {
                  tenantId: tenant.id,
                  userId: dueOffer.agentId,
                  state: 'BREAK',
                  reason: `cooldown:${dueOffer.id}`,
                  endedAt: this.requeueAt(policy.offerCooldownSec),
                },
              });
            } else {
              await transaction.agentStateLog.create({
                data: {
                  tenantId: tenant.id,
                  userId: dueOffer.agentId,
                  state: 'AVAILABLE',
                  reason: dueOffer.id,
                },
              });
            }
            await transaction.interactionEvent.createMany({
              data: [
                {
                  tenantId: tenant.id,
                  interactionId: dueOffer.id,
                  type: 'interaction.offer_timed_out',
                  payload: { agentId: dueOffer.agentId },
                },
                {
                  tenantId: tenant.id,
                  interactionId: dueOffer.id,
                  type: 'interaction.queued',
                  payload: { reason: 'offer_timeout' },
                },
              ],
            });
            if (policy.offerTimeoutAction === 'COOLDOWN_REQUEUE') {
              result.push({
                interactionId: dueOffer.id,
                tenantId: tenant.id,
                queueId: dueOffer.queueId,
                callUuid: dueOffer.externalId,
                ...metadata,
                timedOut: true,
                requeued: true,
              });
              continue;
            }
            const available = await this.findAvailableAgent(
              transaction,
              tenant.id,
              dueOffer.queueId,
              policy.routingStrategy,
            );
            if (!available) {
              result.push({
                interactionId: dueOffer.id,
                tenantId: tenant.id,
                queueId: dueOffer.queueId,
                callUuid: dueOffer.externalId,
                ...metadata,
                timedOut: true,
                requeued: true,
              });
              continue;
            }
            const reassigned = await transaction.interaction.updateMany({
              where: { id: dueOffer.id, tenantId: tenant.id, state: 'QUEUED', agentId: null },
              data: {
                state: 'ASSIGNED',
                agentId: available.id,
                assignedAt: now,
                offerExpiresAt: this.offerExpiresAt(policy.offerTimeoutSec),
              },
            });
            if (reassigned.count === 0) continue;
            await transaction.agentStateLog.create({
              data: {
                tenantId: tenant.id,
                userId: available.id,
                state: 'RESERVED',
                reason: dueOffer.id,
              },
            });
            await transaction.interactionEvent.create({
              data: {
                tenantId: tenant.id,
                interactionId: dueOffer.id,
                type: 'interaction.assigned',
                payload: { agentId: available.id, reason: 'offer_timeout_requeue' },
              },
            });
            result.push({
              interactionId: dueOffer.id,
              tenantId: tenant.id,
              queueId: dueOffer.queueId,
              agentId: available.id,
              agentExtension: available.extension,
              callUuid: dueOffer.externalId,
              ...metadata,
              timedOut: true,
              requeued: true,
            });
          }
          await this.releaseExpiredCooldowns(transaction, tenant.id, now);
          const dueRequeues = await transaction.interaction.findMany({
            where: {
              tenantId: tenant.id,
              channel: 'VOICE',
              state: 'QUEUED',
              requeueAt: { lte: now },
            },
            select: {
              id: true,
              queueId: true,
              externalId: true,
              metadata: true,
              queue: { select: this.queuePolicySelection },
            },
          });
          for (const dueRequeue of dueRequeues) {
            if (!dueRequeue.externalId || !dueRequeue.queue || !dueRequeue.queueId) continue;
            const available = await this.findAvailableAgent(
              transaction,
              tenant.id,
              dueRequeue.queueId,
              this.resolveQueuePolicy(dueRequeue.queue).routingStrategy,
            );
            if (!available) continue;
            const assigned = await transaction.interaction.updateMany({
              where: {
                id: dueRequeue.id,
                tenantId: tenant.id,
                state: 'QUEUED',
                requeueAt: { lte: now },
              },
              data: {
                state: 'ASSIGNED',
                agentId: available.id,
                assignedAt: now,
                offerExpiresAt: this.offerExpiresAt(
                  this.resolveQueuePolicy(dueRequeue.queue).offerTimeoutSec,
                ),
                requeueAt: null,
              },
            });
            if (assigned.count === 0) continue;
            await transaction.agentStateLog.create({
              data: {
                tenantId: tenant.id,
                userId: available.id,
                state: 'RESERVED',
                reason: dueRequeue.id,
              },
            });
            await transaction.interactionEvent.create({
              data: {
                tenantId: tenant.id,
                interactionId: dueRequeue.id,
                type: 'interaction.assigned',
                payload: { agentId: available.id, reason: 'offer_cooldown_elapsed' },
              },
            });
            result.push({
              interactionId: dueRequeue.id,
              tenantId: tenant.id,
              queueId: dueRequeue.queueId,
              agentId: available.id,
              agentExtension: available.extension,
              callUuid: dueRequeue.externalId,
              ...this.telephonyMetadata(dueRequeue.metadata),
              timedOut: false,
              requeued: false,
            });
          }
          const waitingInteractions = await transaction.interaction.findMany({
            where: {
              tenantId: tenant.id,
              channel: 'VOICE',
              state: 'QUEUED',
            },
            select: {
              id: true,
              queueId: true,
              externalId: true,
              metadata: true,
              queuedAt: true,
              queue: { select: this.queuePolicySelection },
            },
          });
          for (const waiting of waitingInteractions) {
            if (!waiting.externalId || !waiting.queue) continue;
            const policy = this.resolveQueuePolicy(waiting.queue);
            if (!policy.maxWaitSec) continue;
            const maxWaitAt = new Date(waiting.queuedAt.getTime() + policy.maxWaitSec * 1_000);
            if (maxWaitAt > now) continue;
            if (policy.maxWaitAction !== 'WAIT') {
              const reason =
                policy.maxWaitAction === 'CALLBACK' ? 'max_wait_callback' : 'max_wait_voicemail';
              const abandoned = await transaction.interaction.updateMany({
                where: {
                  id: waiting.id,
                  tenantId: tenant.id,
                  state: 'QUEUED',
                  queuedAt: waiting.queuedAt,
                },
                data: { state: 'ABANDONED', endedAt: now, requeueAt: null },
              });
              if (abandoned.count === 0) continue;
              await transaction.interactionEvent.create({
                data: {
                  tenantId: tenant.id,
                  interactionId: waiting.id,
                  type: 'interaction.abandoned',
                  payload: { reason },
                },
              });
              result.push({
                interactionId: waiting.id,
                tenantId: tenant.id,
                queueId: waiting.queueId,
                callUuid: waiting.externalId,
                ...this.telephonyMetadata(waiting.metadata),
                timedOut: false,
                requeued: false,
                abandoned: true,
                reason,
              });
              continue;
            }
            const requeued = await transaction.interaction.updateMany({
              where: {
                id: waiting.id,
                tenantId: tenant.id,
                state: 'QUEUED',
                queuedAt: waiting.queuedAt,
              },
              data: { queuedAt: now, requeueAt: now },
            });
            if (requeued.count === 0) continue;
            await transaction.interactionEvent.create({
              data: {
                tenantId: tenant.id,
                interactionId: waiting.id,
                type: 'interaction.queued',
                payload: { reason: 'max_wait_wait' },
              },
            });
            result.push({
              interactionId: waiting.id,
              tenantId: tenant.id,
              queueId: waiting.queueId,
              callUuid: waiting.externalId,
              ...this.telephonyMetadata(waiting.metadata),
              timedOut: false,
              requeued: true,
              reason: 'max_wait_wait',
            });
          }
          return result;
        },
      );
      outcomes.push(...tenantOutcomes);
    }
    for (const outcome of outcomes) await this.publishDueOfferOutcome(outcome);
    for (const timeout of ivrTimeouts) await this.handle(timeout);
  }

  async declineOffer(command: DeclineOfferCommand): Promise<InboundVoiceRoutingResult> {
    const declined = await withTenantDatabaseTransaction(
      this.database,
      command.tenantId,
      async (transaction) => {
        const existing = await transaction.interaction.findFirstOrThrow({
          where: { id: command.interactionId, tenantId: command.tenantId },
          select: {
            id: true,
            state: true,
            agentId: true,
            queue: {
              select: this.queuePolicySelection,
            },
          },
        });
        if (
          existing.state !== 'ASSIGNED' ||
          existing.agentId !== command.agentId ||
          !existing.queue
        ) {
          return { ...existing, transitioned: false as const };
        }
        const policy = this.resolveQueuePolicy(existing.queue);
        const abandoned = policy.offerTimeoutAction === 'ABANDON';
        const requeueAt =
          policy.offerTimeoutAction === 'COOLDOWN_REQUEUE'
            ? this.requeueAt(policy.offerCooldownSec)
            : new Date(this.dependencies.now());
        const updated = await transaction.interaction.updateMany({
          where: {
            id: existing.id,
            tenantId: command.tenantId,
            agentId: command.agentId,
            state: 'ASSIGNED',
          },
          data: abandoned
            ? {
                state: 'ABANDONED',
                endedAt: new Date(this.dependencies.now()),
                offerExpiresAt: null,
              }
            : { state: 'QUEUED', agentId: null, offerExpiresAt: null, requeueAt },
        });
        if (updated.count === 0) return { ...existing, transitioned: false as const };
        await transaction.agentStateLog.create({
          data: {
            tenantId: command.tenantId,
            userId: command.agentId,
            state: policy.offerTimeoutAction === 'COOLDOWN_REQUEUE' ? 'BREAK' : 'AVAILABLE',
            reason:
              policy.offerTimeoutAction === 'COOLDOWN_REQUEUE'
                ? `cooldown:${existing.id}`
                : existing.id,
            ...(policy.offerTimeoutAction === 'COOLDOWN_REQUEUE' ? { endedAt: requeueAt } : {}),
          },
        });
        await transaction.interactionEvent.createMany({
          data: [
            {
              tenantId: command.tenantId,
              interactionId: existing.id,
              type: 'interaction.offer_declined',
              payload: { agentId: command.agentId },
            },
            {
              tenantId: command.tenantId,
              interactionId: existing.id,
              type: abandoned ? 'interaction.abandoned' : 'interaction.queued',
              payload: { reason: 'agent_declined' },
            },
          ],
        });
        return {
          ...existing,
          state: abandoned ? ('ABANDONED' as const) : ('QUEUED' as const),
          agentId: abandoned ? existing.agentId : null,
          transitioned: true as const,
          abandoned,
        };
      },
    );
    if (declined.transitioned) {
      await this.dependencies.publish(
        KAFKA_TOPICS.INTERACTION_EVENTS,
        this.decisionEnvelope(command, 'interaction.offer_declined', {
          interactionId: declined.id,
          channel: 'VOICE',
          state: declined.state,
          agentId: command.agentId,
        }),
      );
      await this.dependencies.publish(
        KAFKA_TOPICS.INTERACTION_EVENTS,
        this.decisionEnvelope(
          command,
          declined.abandoned ? 'interaction.abandoned' : 'interaction.queued',
          {
            interactionId: declined.id,
            channel: 'VOICE',
            state: declined.state,
            ...(declined.agentId ? { agentId: declined.agentId } : {}),
          },
        ),
      );
    }
    return {
      interactionId: declined.id,
      status: declined.state,
      ...(declined.agentId ? { agentId: declined.agentId } : {}),
    };
  }

  async completeWrapUp(command: CompleteWrapUpCommand): Promise<InboundVoiceRoutingResult> {
    const code = command.code.trim();
    if (!code) throw new Error('wrap-up code is required');
    const completed = await withTenantDatabaseTransaction(
      this.database,
      command.tenantId,
      async (transaction) => {
        const existing = await transaction.interaction.findFirstOrThrow({
          where: { id: command.interactionId, tenantId: command.tenantId },
          select: { id: true, state: true, agentId: true },
        });
        if (existing.state === 'COMPLETED') return { ...existing, transitioned: false as const };
        if (existing.state !== 'WRAPUP' || existing.agentId !== command.agentId) {
          throw new Error('wrap-up requires the assigned agent');
        }
        const result = await transaction.interaction.updateMany({
          where: {
            id: existing.id,
            tenantId: command.tenantId,
            agentId: command.agentId,
            state: 'WRAPUP',
          },
          data: { state: 'COMPLETED', wrapUpCode: code },
        });
        if (result.count === 0) return { ...existing, transitioned: false as const };
        await transaction.agentStateLog.create({
          data: {
            tenantId: command.tenantId,
            userId: command.agentId,
            state: 'AVAILABLE',
            reason: existing.id,
          },
        });
        await transaction.interactionEvent.create({
          data: {
            tenantId: command.tenantId,
            interactionId: existing.id,
            type: 'interaction.wrapup_completed',
            payload: { agentId: command.agentId, wrapUpCode: code },
          },
        });
        return { ...existing, state: 'COMPLETED' as const, transitioned: true as const };
      },
    );
    if (completed.transitioned) {
      await this.dependencies.publish(
        KAFKA_TOPICS.INTERACTION_EVENTS,
        this.commandEnvelope(command, 'interaction.wrapup_completed', {
          interactionId: completed.id,
          channel: 'VOICE',
          state: 'COMPLETED',
          agentId: command.agentId,
          wrapUpCode: code,
        }),
      );
    }
    return {
      interactionId: completed.id,
      status: completed.state,
      ...(completed.agentId ? { agentId: completed.agentId } : {}),
    };
  }

  private async handleIvrInput(
    event: KafkaEventEnvelope<TelephonyCallEvent>,
  ): Promise<InboundVoiceRoutingResult> {
    if (event.orderingKey !== event.payload.callUuid) {
      throw new Error('telephony event orderingKey must equal callUuid');
    }
    const result = await withTenantDatabaseTransaction(
      this.database,
      event.tenantId,
      async (transaction) => {
        const interaction = await transaction.interaction.findFirstOrThrow({
          where: { tenantId: event.tenantId, externalId: event.payload.callUuid },
          select: {
            id: true,
            state: true,
            agentId: true,
            ivrDestinationId: true,
            ivrStage: true,
            ivrAttempts: true,
            ivrInputExpiresAt: true,
          },
        });
        if (
          interaction.state !== 'QUEUED' ||
          !interaction.ivrDestinationId ||
          !interaction.ivrStage
        ) {
          return this.resultFromInteraction(interaction);
        }
        if (
          event.payload.inputMode === 'TIMEOUT' &&
          (!interaction.ivrInputExpiresAt ||
            interaction.ivrInputExpiresAt > new Date(this.dependencies.now()))
        ) {
          return this.resultFromInteraction(interaction);
        }
        const destination = await transaction.voiceDestination.findFirstOrThrow({
          where: { id: interaction.ivrDestinationId, tenantId: event.tenantId, entryMode: 'IVR' },
          select: { queueId: true, ivrConfig: true, queue: { select: this.queuePolicySelection } },
        });
        const configuration = this.ivrConfiguration(destination.ivrConfig);
        const inputMode = event.payload.inputMode;
        const inputValue = event.payload.inputValue;
        const route =
          interaction.ivrStage === 'VOICE' && inputMode === 'VOICE' && inputValue
            ? configuration.voiceRoutes[this.normalizedVoiceInput(inputValue)]
            : interaction.ivrStage === 'VOICE' && inputMode === 'DTMF' && inputValue
              ? configuration.dtmfRoutes[inputValue.trim()]
              : interaction.ivrStage === 'DTMF' && inputMode === 'DTMF' && inputValue
                ? configuration.dtmfRoutes[inputValue.trim()]
                : undefined;
        const attempts = route ? interaction.ivrAttempts : interaction.ivrAttempts + 1;
        if (!route && interaction.ivrStage === 'VOICE' && attempts < 2) {
          await transaction.interaction.updateMany({
            where: { id: interaction.id, tenantId: event.tenantId, state: 'QUEUED' },
            data: {
              ivrStage: 'DTMF',
              ivrAttempts: attempts,
              ivrInputExpiresAt: this.ivrInputExpiresAt(configuration.inputTimeoutSec),
            },
          });
          await transaction.interactionEvent.create({
            data: {
              tenantId: event.tenantId,
              interactionId: interaction.id,
              type: 'interaction.ivr_dtmf_fallback',
              payload: {},
            },
          });
          return {
            interactionId: interaction.id,
            status: 'QUEUED' as const,
            ivrCollect: {
              interactionId: interaction.id,
              inputMode: 'DTMF' as const,
              prompt: configuration.prompt,
              timeoutSec: configuration.inputTimeoutSec,
            },
          };
        }
        const queueId = route ?? (attempts >= 2 ? destination.queueId : undefined);
        if (!queueId) {
          await transaction.interaction.updateMany({
            where: { id: interaction.id, tenantId: event.tenantId, state: 'QUEUED' },
            data: {
              ivrStage: 'VOICE',
              ivrAttempts: attempts,
              ivrInputExpiresAt: this.ivrInputExpiresAt(configuration.inputTimeoutSec),
            },
          });
          return {
            interactionId: interaction.id,
            status: 'QUEUED' as const,
            ivrCollect: {
              interactionId: interaction.id,
              inputMode: 'VOICE' as const,
              prompt: configuration.prompt,
              timeoutSec: configuration.inputTimeoutSec,
            },
          };
        }
        const policy = this.resolveQueuePolicy(destination.queue);
        const available = await this.findAvailableAgent(
          transaction,
          event.tenantId,
          queueId,
          policy.routingStrategy,
        );
        const resolved = await transaction.interaction.update({
          where: { id: interaction.id },
          data: {
            queueId,
            ivrStage: null,
            ivrInputExpiresAt: null,
            ivrAttempts: attempts,
            ...(available
              ? {
                  state: 'ASSIGNED' as const,
                  agentId: available.id,
                  assignedAt: new Date(this.dependencies.now()),
                  offerExpiresAt: this.offerExpiresAt(policy.offerTimeoutSec),
                }
              : {}),
          },
          select: { id: true, state: true, agentId: true },
        });
        if (available) {
          await transaction.agentStateLog.create({
            data: {
              tenantId: event.tenantId,
              userId: available.id,
              state: 'RESERVED',
              reason: resolved.id,
            },
          });
        }
        await transaction.interactionEvent.createMany({
          data: [
            {
              tenantId: event.tenantId,
              interactionId: resolved.id,
              type: 'interaction.ivr_resolved',
              payload: { queueId, ...(route ? { inputMode } : { reason: 'ivr_max_attempts' }) },
            },
            {
              tenantId: event.tenantId,
              interactionId: resolved.id,
              type: available ? 'interaction.assigned' : 'interaction.queued',
              payload: { queueId, ...(available ? { agentId: available.id } : {}) },
            },
          ],
        });
        return {
          interactionId: resolved.id,
          status: resolved.state,
          ...(available
            ? { agentId: available.id, agentExtension: available.extension, queueId }
            : { queueId }),
        };
      },
    );
    if ('ivrCollect' in result) {
      await this.publishCollect(event, result.ivrCollect!);
    } else if (result.status === 'ASSIGNED' && 'agentExtension' in result) {
      await this.publishIvrResolution(event, result);
    } else if (!('deduplicated' in result)) {
      await this.dependencies.publish(
        KAFKA_TOPICS.INTERACTION_EVENTS,
        this.envelope(event, result.interactionId, 'interaction.queued', {
          interactionId: result.interactionId,
          channel: 'VOICE',
          state: 'QUEUED',
          ...('queueId' in result && result.queueId ? { queueId: result.queueId } : {}),
        }),
      );
    }
    return {
      interactionId: result.interactionId,
      status: result.status,
      ...('agentId' in result && result.agentId ? { agentId: result.agentId } : {}),
    };
  }

  private async handleAnswered(
    event: KafkaEventEnvelope<TelephonyCallEvent>,
  ): Promise<InboundVoiceRoutingResult> {
    const interaction = await withTenantDatabaseTransaction(
      this.database,
      event.tenantId,
      async (transaction) => {
        const existing = await transaction.interaction.findFirstOrThrow({
          where: { tenantId: event.tenantId, externalId: event.payload.callUuid },
          select: { id: true, state: true, agentId: true, offerExpiresAt: true },
        });
        if (existing.state === 'ACTIVE') return { ...existing, transitioned: false as const };
        if (existing.state !== 'ASSIGNED' || !existing.agentId) {
          return { ...existing, transitioned: false as const };
        }
        const answeredAt = new Date(this.dependencies.now());
        const claimed = await transaction.interaction.updateMany({
          where: {
            id: existing.id,
            tenantId: event.tenantId,
            state: 'ASSIGNED',
            ...(existing.offerExpiresAt ? { offerExpiresAt: { gt: answeredAt } } : {}),
          },
          data: { state: 'ACTIVE', answeredAt, offerExpiresAt: null },
        });
        if (claimed.count === 0) {
          const current = await transaction.interaction.findFirstOrThrow({
            where: { id: existing.id, tenantId: event.tenantId },
            select: { id: true, state: true, agentId: true },
          });
          return { ...current, transitioned: false as const };
        }
        await transaction.agentStateLog.create({
          data: {
            tenantId: event.tenantId,
            userId: existing.agentId,
            state: 'BUSY',
            reason: existing.id,
          },
        });
        await transaction.interactionEvent.create({
          data: {
            tenantId: event.tenantId,
            interactionId: existing.id,
            type: 'interaction.answered',
            payload: { agentId: existing.agentId },
          },
        });
        return {
          id: existing.id,
          state: 'ACTIVE' as const,
          agentId: existing.agentId,
          transitioned: true as const,
        };
      },
    );
    if (interaction.transitioned) {
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
    return {
      interactionId: interaction.id,
      status: interaction.state,
      ...(interaction.agentId ? { agentId: interaction.agentId } : {}),
    };
  }

  private async handleHangup(
    event: KafkaEventEnvelope<TelephonyCallEvent>,
  ): Promise<InboundVoiceRoutingResult> {
    const interaction = await withTenantDatabaseTransaction(
      this.database,
      event.tenantId,
      async (transaction) => {
        const existing = await transaction.interaction.findFirstOrThrow({
          where: { tenantId: event.tenantId, externalId: event.payload.callUuid },
          select: { id: true, state: true, agentId: true },
        });
        if (
          existing.state === 'WRAPUP' ||
          existing.state === 'COMPLETED' ||
          existing.state === 'ABANDONED'
        ) {
          return { ...existing, transitioned: false as const };
        }
        if (existing.state === 'QUEUED' || existing.state === 'ASSIGNED') {
          const result = await transaction.interaction.updateMany({
            where: {
              id: existing.id,
              tenantId: event.tenantId,
              state: existing.state,
            },
            data: {
              state: 'ABANDONED',
              endedAt: new Date(this.dependencies.now()),
              offerExpiresAt: null,
              requeueAt: null,
            },
          });
          if (result.count === 0) return { ...existing, transitioned: false as const };
          if (existing.agentId) {
            await transaction.agentStateLog.create({
              data: {
                tenantId: event.tenantId,
                userId: existing.agentId,
                state: 'AVAILABLE',
                reason: existing.id,
              },
            });
          }
          await transaction.interactionEvent.create({
            data: {
              tenantId: event.tenantId,
              interactionId: existing.id,
              type: 'interaction.abandoned',
              payload: {
                reason: 'caller_hangup',
                ...(existing.agentId ? { agentId: existing.agentId } : {}),
              },
            },
          });
          return { ...existing, state: 'ABANDONED' as const, transitioned: true as const };
        }
        if (existing.state !== 'ACTIVE' || !existing.agentId) {
          throw new Error('call.hangup requires an active interaction');
        }
        const result = await transaction.interaction.updateMany({
          where: { id: existing.id, tenantId: event.tenantId, state: 'ACTIVE' },
          data: { state: 'WRAPUP', endedAt: new Date(this.dependencies.now()) },
        });
        if (result.count === 0) return { ...existing, transitioned: false as const };
        await transaction.agentStateLog.create({
          data: {
            tenantId: event.tenantId,
            userId: existing.agentId,
            state: 'ACW',
            reason: existing.id,
          },
        });
        await transaction.interactionEvent.create({
          data: {
            tenantId: event.tenantId,
            interactionId: existing.id,
            type: 'interaction.ended',
            payload: { agentId: existing.agentId },
          },
        });
        return { ...existing, state: 'WRAPUP' as const, transitioned: true as const };
      },
    );
    if (interaction.transitioned) {
      const abandoned = interaction.state === 'ABANDONED';
      await this.dependencies.publish(
        KAFKA_TOPICS.INTERACTION_EVENTS,
        this.envelope(
          event,
          interaction.id,
          abandoned ? 'interaction.abandoned' : 'interaction.ended',
          {
            interactionId: interaction.id,
            channel: 'VOICE',
            state: interaction.state,
            ...(interaction.agentId ? { agentId: interaction.agentId } : {}),
          },
        ),
      );
    }
    return {
      interactionId: interaction.id,
      status: interaction.state,
      ...(interaction.agentId ? { agentId: interaction.agentId } : {}),
    };
  }

  private resultFromInteraction(interaction: {
    id: string;
    state: InteractionStateType;
    agentId: string | null;
  }) {
    return {
      interactionId: interaction.id,
      status: interaction.state,
      ...(interaction.agentId ? { agentId: interaction.agentId } : {}),
      deduplicated: true as const,
    };
  }

  private async findAvailableAgent(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    queueId: string,
    routingStrategy: QueuePolicySource['routingStrategy'],
  ) {
    const ordering =
      routingStrategy === 'LONGEST_SINCE_LAST_INTERACTION'
        ? Prisma.sql`last_interaction.ended_at ASC NULLS FIRST, u.id`
        : routingStrategy === 'ROUND_ROBIN'
          ? Prisma.sql`last_assignment.assigned_at ASC NULLS FIRST, u.id`
          : Prisma.sql`latest.started_at ASC, u.id`;
    const agents = await transaction.$queryRaw<AvailableAgent[]>(Prisma.sql`
      SELECT u.id, u.extension
      FROM users u
      JOIN LATERAL (
        SELECT state, started_at
        FROM agent_state_logs states
        WHERE states.tenant_id = ${tenantId}::uuid AND states.user_id = u.id
        ORDER BY states.started_at DESC, states.id DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN LATERAL (
        SELECT MAX(ended_at) AS ended_at
        FROM interactions
        WHERE tenant_id = ${tenantId}::uuid AND agent_id = u.id AND ended_at IS NOT NULL
      ) last_interaction ON true
      LEFT JOIN LATERAL (
        SELECT MAX(assigned_at) AS assigned_at
        FROM interactions
        WHERE tenant_id = ${tenantId}::uuid AND agent_id = u.id AND assigned_at IS NOT NULL
      ) last_assignment ON true
      WHERE u.tenant_id = ${tenantId}::uuid
        AND u.role = 'AGENT'
        AND u.is_active = true
        AND u.extension IS NOT NULL
        AND latest.state = 'AVAILABLE'
        AND NOT EXISTS (
          SELECT 1
          FROM queue_skills required_skill
          LEFT JOIN agent_skills agent_skill
            ON agent_skill.skill_id = required_skill.skill_id
            AND agent_skill.user_id = u.id
          WHERE required_skill.queue_id = ${queueId}::uuid
            AND (agent_skill.user_id IS NULL OR agent_skill.level < required_skill.min_level)
        )
      ORDER BY ${ordering}
      FOR UPDATE OF u SKIP LOCKED
      LIMIT 1
    `);
    return agents[0];
  }

  private resolveQueuePolicy(queue: QueuePolicySource) {
    return {
      offerTimeoutSec: queue.offerTimeoutSec ?? queue.tenant.defaultOfferTimeoutSec,
      offerTimeoutAction: queue.offerTimeoutAction ?? queue.tenant.defaultOfferTimeoutAction,
      offerCooldownSec: queue.offerCooldownSec ?? queue.tenant.defaultOfferCooldownSec,
      maxWaitSec: queue.maxWaitSec ?? queue.tenant.defaultMaxWaitSec,
      maxWaitAction: queue.maxWaitAction ?? queue.tenant.defaultMaxWaitAction,
      routingStrategy: queue.routingStrategy,
    };
  }

  private ivrConfiguration(value: Prisma.JsonValue | null): IvrConfiguration {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('IVR destination is missing configuration');
    }
    const configuration = value as Partial<IvrConfiguration>;
    const inputTimeoutSec = configuration.inputTimeoutSec;
    if (
      typeof configuration.prompt !== 'string' ||
      typeof inputTimeoutSec !== 'number' ||
      !Number.isInteger(inputTimeoutSec) ||
      inputTimeoutSec < 1 ||
      !configuration.voiceRoutes ||
      typeof configuration.voiceRoutes !== 'object' ||
      Array.isArray(configuration.voiceRoutes) ||
      !configuration.dtmfRoutes ||
      typeof configuration.dtmfRoutes !== 'object' ||
      Array.isArray(configuration.dtmfRoutes)
    ) {
      throw new Error('IVR destination has invalid configuration');
    }
    return {
      prompt: configuration.prompt,
      inputTimeoutSec,
      voiceRoutes: configuration.voiceRoutes as Record<string, string>,
      dtmfRoutes: configuration.dtmfRoutes as Record<string, string>,
    };
  }

  private normalizedVoiceInput(value: string) {
    return value.trim().toLocaleLowerCase('th-TH').replaceAll(/\s+/g, ' ');
  }

  private ivrInputExpiresAt(seconds: number) {
    return new Date(new Date(this.dependencies.now()).getTime() + seconds * 1_000);
  }

  private offerExpiresAt(seconds: number) {
    return new Date(new Date(this.dependencies.now()).getTime() + seconds * 1_000);
  }

  private requeueAt(seconds: number) {
    return new Date(new Date(this.dependencies.now()).getTime() + seconds * 1_000);
  }

  private async releaseExpiredCooldowns(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    now: Date,
  ) {
    const agents = await transaction.$queryRaw<{ userId: string }[]>(Prisma.sql`
      SELECT states.user_id AS "userId"
      FROM agent_state_logs states
      WHERE states.tenant_id = ${tenantId}::uuid
        AND states.state = 'BREAK'
        AND states.reason LIKE 'cooldown:%'
        AND states.ended_at <= ${now}
        AND NOT EXISTS (
          SELECT 1
          FROM agent_state_logs later
          WHERE later.tenant_id = states.tenant_id
            AND later.user_id = states.user_id
            AND (later.started_at, later.id) > (states.started_at, states.id)
        )
      FOR UPDATE OF states SKIP LOCKED
    `);
    if (agents.length === 0) return;
    await transaction.agentStateLog.createMany({
      data: agents.map((agent) => ({
        tenantId,
        userId: agent.userId,
        state: 'AVAILABLE' as const,
        reason: 'offer_cooldown_elapsed',
      })),
    });
  }

  private telephonyMetadata(
    metadata: Prisma.JsonValue | null,
  ): Pick<DueOfferOutcome, 'vendor' | 'telephonyNodeId'> {
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      (metadata.vendor !== 'freeswitch' && metadata.vendor !== 'asterisk') ||
      typeof metadata.telephonyNodeId !== 'string'
    ) {
      throw new Error('voice interaction is missing telephony metadata');
    }
    return { vendor: metadata.vendor, telephonyNodeId: metadata.telephonyNodeId };
  }

  private telephonyCallMetadata(metadata: Prisma.JsonValue | null): TelephonyCallMetadata {
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      (metadata.vendor !== 'freeswitch' && metadata.vendor !== 'asterisk') ||
      typeof metadata.telephonyNodeId !== 'string' ||
      typeof metadata.caller !== 'string' ||
      typeof metadata.destination !== 'string'
    ) {
      throw new Error('voice interaction is missing telephony metadata');
    }
    return {
      vendor: metadata.vendor,
      telephonyNodeId: metadata.telephonyNodeId,
      caller: metadata.caller,
      destination: metadata.destination,
    };
  }

  private async publishDueOfferOutcome(outcome: DueOfferOutcome) {
    if (outcome.timedOut) {
      await this.dependencies.publish(
        KAFKA_TOPICS.INTERACTION_EVENTS,
        this.scheduledEnvelope(outcome, outcome.interactionId, 'interaction.offer_timed_out', {
          interactionId: outcome.interactionId,
          channel: 'VOICE',
          state: outcome.abandoned ? 'ABANDONED' : outcome.agentId ? 'ASSIGNED' : 'QUEUED',
          ...(outcome.queueId ? { queueId: outcome.queueId } : {}),
        }),
      );
    }
    if (outcome.abandoned) {
      await this.dependencies.publish(
        KAFKA_TOPICS.INTERACTION_EVENTS,
        this.scheduledEnvelope(outcome, outcome.interactionId, 'interaction.abandoned', {
          interactionId: outcome.interactionId,
          channel: 'VOICE',
          state: 'ABANDONED',
          ...(outcome.queueId ? { queueId: outcome.queueId } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        }),
      );
      return;
    }
    if (outcome.requeued) {
      await this.dependencies.publish(
        KAFKA_TOPICS.INTERACTION_EVENTS,
        this.scheduledEnvelope(outcome, outcome.interactionId, 'interaction.queued', {
          interactionId: outcome.interactionId,
          channel: 'VOICE',
          state: outcome.agentId ? 'ASSIGNED' : 'QUEUED',
          ...(outcome.queueId ? { queueId: outcome.queueId } : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        }),
      );
    }
    if (!outcome.agentId || !outcome.agentExtension) return;
    await this.dependencies.publish(
      KAFKA_TOPICS.AGENT_EVENTS,
      this.scheduledEnvelope(outcome, outcome.interactionId, 'routing.offered', {
        interactionId: outcome.interactionId,
        userId: outcome.agentId,
        ...(outcome.queueId ? { queueId: outcome.queueId } : {}),
      }),
    );
    const command: TelephonyCommand = {
      callUuid: outcome.callUuid,
      vendor: outcome.vendor,
      telephonyNodeId: outcome.telephonyNodeId,
      type: 'call.bridge',
      agentExtension: outcome.agentExtension,
    };
    await this.dependencies.publish(
      KAFKA_TOPICS.TELEPHONY_COMMANDS,
      this.scheduledEnvelope(outcome, outcome.callUuid, 'call.bridge', command),
    );
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
      await this.dependencies.publish(
        KAFKA_TOPICS.INTERACTION_EVENTS,
        this.envelope(input, interactionId, type, {
          interactionId,
          channel: 'VOICE',
          state: type === 'interaction.assigned' ? 'ASSIGNED' : 'QUEUED',
          ...(queueId ? { queueId } : {}),
          ...(agentId ? { agentId } : {}),
        }),
      );
    }
  }

  private async publishCollect(
    event: KafkaEventEnvelope<TelephonyCallEvent>,
    collect: IvrCollectRequest,
  ) {
    const command: TelephonyCommand = {
      callUuid: event.payload.callUuid,
      vendor: event.payload.vendor,
      telephonyNodeId: event.payload.telephonyNodeId,
      type: 'call.collect',
      inputMode: collect.inputMode,
      prompt: collect.prompt,
      timeoutSec: collect.timeoutSec,
    };
    await this.dependencies.publish(
      KAFKA_TOPICS.TELEPHONY_COMMANDS,
      this.envelope(event, event.payload.callUuid, 'call.collect', command),
    );
  }

  private async publishIvrResolution(
    event: KafkaEventEnvelope<TelephonyCallEvent>,
    result: InboundVoiceRoutingResult & { agentExtension: string; queueId: string },
  ) {
    await this.dependencies.publish(
      KAFKA_TOPICS.INTERACTION_EVENTS,
      this.envelope(event, result.interactionId, 'interaction.assigned', {
        interactionId: result.interactionId,
        channel: 'VOICE',
        state: 'ASSIGNED',
        agentId: result.agentId!,
        queueId: result.queueId,
      }),
    );
    const command: TelephonyCommand = {
      callUuid: event.payload.callUuid,
      vendor: event.payload.vendor,
      telephonyNodeId: event.payload.telephonyNodeId,
      type: 'call.bridge',
      agentExtension: result.agentExtension,
    };
    await this.dependencies.publish(
      KAFKA_TOPICS.TELEPHONY_COMMANDS,
      this.envelope(event, event.payload.callUuid, 'call.bridge', command),
    );
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

  private commandEnvelope(
    command: CompleteWrapUpCommand,
    type: string,
    payload: Record<string, unknown>,
  ): PublishedEvent {
    return {
      eventId: this.dependencies.eventId(),
      type,
      tenantId: command.tenantId,
      occurredAt: this.dependencies.now(),
      correlationId: command.interactionId,
      orderingKey: command.interactionId,
      payload,
    };
  }

  private decisionEnvelope(
    command: DeclineOfferCommand,
    type: string,
    payload: Record<string, unknown>,
  ): PublishedEvent {
    return {
      eventId: this.dependencies.eventId(),
      type,
      tenantId: command.tenantId,
      occurredAt: this.dependencies.now(),
      correlationId: command.interactionId,
      orderingKey: command.interactionId,
      payload,
    };
  }

  private scheduledEnvelope(
    outcome: DueOfferOutcome,
    orderingKey: string,
    type: string,
    payload: Record<string, unknown>,
  ): PublishedEvent {
    return {
      eventId: this.dependencies.eventId(),
      type,
      tenantId: outcome.tenantId,
      occurredAt: this.dependencies.now(),
      correlationId: outcome.callUuid,
      orderingKey,
      payload,
    };
  }
}
