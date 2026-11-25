/**
 * J2.8 (#136) — Kafka transport of the owner command
 *
 * `JourneyOwnerCommandRelay` takes a `J2OwnerPort` directly, so the transport can be changed without
 * touching the relay at all. Before this there were only ports that called Cases/Dialer in-process (J2.4–J2.6),
 * so the first item of #136, "relay `dc.case.commands`/`dc.dialer.commands` at-least-once and
 * mark dispatch after the broker ack", never really existed
 *
 * The two halves of the port have clearly separate jobs:
 *
 *   persistCommand — publishes to the topic and waits for the broker ack before returning `PERSISTED`
 *     exactly per the contract that `J2OwnerCommandPersistedV1` writes itself: "Dispatch success confirms
 *     durable command/outbox persistence, not the business effect" — the broker ack is real durable
 *     persistence, while the owner-side effect is a separate matter that follows later, so the relay can mark
 *     SENT honestly without claiming the owner has finished the work
 *
 *   queryAction — publishes an owner action query and returns undefined; the real result comes back through the result consumer
 *
 * the ordering key uses actionKey (per the J2.1 envelope contract) so that commands of the same action always go to the same partition
 * — the owner therefore surely sees CANCEL/SUPERSEDE after the original command
 */
import { randomUUID } from 'node:crypto';
import type { DcProducer } from '@d-contact/kafka';
import type { KafkaTopic } from '@d-contact/shared';
import {
  actionKey as toActionKey,
  commandId as toCommandId,
  assertOwnerCommandEnvelope,
  createOwnerActionQueryEnvelope,
  assertOwnerRequestHash,
  J2_COMMAND_EVENT_TYPE,
  type J2OwnerActionQueryV1,
  type J2OwnerCommandPayloadV1,
  type J2OwnerCommandPersistedV1,
  type J2OwnerPort,
  type J2OwnerResultPayloadV1,
  type TenantId,
} from '@d-contact/cxa-contracts';

export interface KafkaOwnerCommandPortOptions {
  topic: KafkaTopic;
  producer: DcProducer;
  now?: () => Date;
}

export function createKafkaOwnerCommandPort<TCommand extends J2OwnerCommandPayloadV1>(
  options: KafkaOwnerCommandPortOptions,
): J2OwnerPort<TCommand> {
  const now = options.now ?? (() => new Date());

  return {
    async persistCommand(tenant: TenantId, command: TCommand): Promise<J2OwnerCommandPersistedV1> {
      // always validate before publishing — a payload/envelope that violates the contract must not leak onto the topic
      // the owner checks with the same assertOwnerCommandEnvelope (J2.1): eventId = commandId so that
      // a retry of the same command is the same event, orderingKey = actionKey so that CANCEL/SUPERSEDE,
      // which use the same actionKey per the contract, always land in the same partition as the original command
      const validated = assertOwnerRequestHash(tenant, command);
      const envelope = assertOwnerCommandEnvelope({
        schemaVersion: 2,
        eventKind: 'COMMAND',
        eventId: validated.commandId,
        type: J2_COMMAND_EVENT_TYPE[validated.commandType],
        tenantId: tenant,
        occurredAt: now().toISOString(),
        correlationId: validated.commandId,
        orderingKey: validated.actionKey,
        aggregateType: 'journey_action',
        aggregateId: validated.actionKey,
        aggregateVersion: 0,
        payload: validated as unknown as Record<string, unknown>,
      });

      await options.producer.send(
        options.topic,
        envelope as unknown as Parameters<DcProducer['send']>[1],
      );

      return {
        status: 'PERSISTED',
        commandId: toCommandId(validated.commandId),
        actionKey: toActionKey(validated.actionKey),
        requestHash: validated.requestHash,
      };
    },

    /**
     * asks the owner asynchronously: publishes `journey.owner_action_query_requested` to the owner's topic and
     * returns `undefined` immediately ("no result in hand yet") — the owner answers from an existing receipt with the original result event
     * which flows back through the result consumer and is applied idempotently like a normal result
     *
     * does not synthesize a result from `jr_owner_result_inbox` in-house and does not retry the original command instead of asking: an owner
     * that never received the command will answer nothing, leaving bounded escalation to hand over to a person to decide through an audited
     * replay (#123)
     */
    async queryAction(
      tenant: TenantId,
      query: J2OwnerActionQueryV1,
    ): Promise<J2OwnerResultPayloadV1 | undefined> {
      const envelope = createOwnerActionQueryEnvelope(tenant, query, {
        eventId: `query:${randomUUID()}`,
        correlationId: query.actionKey,
        occurredAt: now().toISOString(),
      });
      await options.producer.send(
        options.topic,
        envelope as unknown as Parameters<DcProducer['send']>[1],
      );
      return undefined;
    },
  };
}
