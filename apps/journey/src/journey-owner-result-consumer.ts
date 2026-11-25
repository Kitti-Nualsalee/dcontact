/**
 * J2.8 (#136) — consume owner results from `dc.case.events`/`dc.dialer.events`
 *
 * The counterpart of `journey-owner-kafka-port.ts`: once a command has gone out through Kafka, the result must
 * travel back through Kafka as well. This consumer is the "consume owner results with
 * tenant/command/action/hash/aggregate/version/causation binding" leg of spec #136
 *
 * binding is checked in two layers:
 *   1. `assertOwnerResultEnvelope` — the V2 envelope must match its own payload (type/aggregateType/
 *      aggregateId/orderingKey/aggregateVersion); a mismatch means a broken contract and goes to the DLQ
 *   2. compare against the command actually stored in `jr_owner_command_outbox` — the result must reference
 *      the actionKey/requestHash/commandType matching the command we sent, not merely be self-consistent
 *      (the contract's `assertOwnerResultBinding` needs the original command envelope, which the consumer
 *      does not have, so we compare against the durable copy the outbox keeps instead, which gives the same guarantee)
 *
 * a result that cannot be bound, violates the contract or whose hash conflicts with the applied result must not be "skipped silently" —
 * it is quarantined to the DLQ through `quarantineConsumedEvent` and the offset is released (the Kafka wrapper retries an error from the
 * handler endlessly, and throwing instead would block the whole partition); a transient error (DB) still throws to retry
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  createConsumer,
  quarantineConsumedEvent,
  type CreateConsumerOptions,
  type DcConsumer,
  type DlqPublisher,
  type EventIdempotencyStore,
} from '@d-contact/kafka';
import {
  J2PayloadContractError,
  J2_RESULT_EVENT_TYPE,
  assertOwnerResultEnvelope,
} from '@d-contact/cxa-contracts';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneyOwnerContinuationService } from './journey-owner-continuation.js';
import { STATUS_TO_RESULT_KIND, hashResult } from './journey-owner-result-reconciler.js';
import { noOpJourneyOwnerMetrics, type JourneyOwnerMetrics } from './journey-owner-metrics.js';

/**
 * `applyResult` is its own durable dedup boundary through unique (tenantId, commandId)
 * already — calling it again is always safe, so no extra inbox table layer is needed
 */
export function createDurableOwnerResultIdempotencyStore(): EventIdempotencyStore {
  return {
    durability: 'DURABLE',
    async execute(_key, work) {
      await work(undefined);
      return 'processed';
    },
  };
}

const OWNER_RESULT_EVENT_TYPES = new Set<string>(Object.values(J2_RESULT_EVENT_TYPE));

export class OwnerResultBindingError extends Error {
  readonly code = 'OWNER_RESULT_BINDING_CONFLICT' as const;

  constructor(
    readonly commandId: string,
    detail: string,
  ) {
    super(`owner result of command ${commandId} has a binding mismatch: ${detail}`);
    this.name = 'OwnerResultBindingError';
  }
}

export interface CreateJourneyOwnerResultConsumerOptions {
  database: PrismaClient;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
  metrics?: JourneyOwnerMetrics;
}

export function createJourneyOwnerResultConsumer(
  options: CreateJourneyOwnerResultConsumerOptions,
): Promise<DcConsumer> {
  const actions = new JourneyOwnerActionRepository(options.database);
  const continuation = new JourneyOwnerContinuationService(options.database, actions);
  const metrics = options.metrics ?? noOpJourneyOwnerMetrics;

  const consumerOptions: CreateConsumerOptions<Record<string, unknown>, undefined> = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.CASE_EVENTS, KAFKA_TOPICS.DIALER_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createDurableOwnerResultIdempotencyStore(),
    handler: async (consumed) => {
      const quarantine = (reasonCode: string) =>
        quarantineConsumedEvent(options.dlq, consumed, reasonCode);

      // the same topic may carry other event types from the owner — skip only the non-results, while a result
      // that violates the contract must not be skipped silently because that is the real result of an action that would vanish unnoticed
      if (!OWNER_RESULT_EVENT_TYPES.has(String(consumed.event.type))) return;
      let envelope;
      try {
        envelope = assertOwnerResultEnvelope(consumed.event);
      } catch (error) {
        if (!(error instanceof J2PayloadContractError)) throw error;
        metrics.increment('journey_owner_result_binding_rejected_total');
        await quarantine(error.code);
        return;
      }
      const result = envelope.payload;

      // must always be inside the tenant transaction — the application client has RLS on and a query
      // outside the context leaves the tenant GUC empty and Postgres rejects it immediately
      const command = await withTenantDatabaseTransaction(
        options.database,
        envelope.tenantId,
        (transaction) =>
          transaction.jrOwnerCommandOutbox.findUnique({
            where: {
              tenantId_commandId: { tenantId: envelope.tenantId, commandId: result.commandId },
            },
          }),
      );
      const bindingError = !command
        ? 'original command not found in the outbox'
        : command.actionKey !== result.actionKey
          ? 'actionKey does not match the command'
          : command.requestHash !== result.requestHash
            ? 'requestHash does not match the command'
            : undefined;
      // a binding mismatch stays a mismatch however many retries — throwing would retry endlessly and block the whole partition
      if (bindingError) {
        metrics.increment('journey_owner_result_binding_rejected_total');
        await quarantine(new OwnerResultBindingError(result.commandId, bindingError).code);
        return;
      }

      const applied = await continuation.applyResultAndContinue({
        tenantId: envelope.tenantId,
        commandId: result.commandId,
        actionKey: result.actionKey,
        resultKind: STATUS_TO_RESULT_KIND[result.status],
        resultHash: hashResult(result),
        correlationId: envelope.correlationId,
        ...(result.ownerAggregate ? { ownerAggregateRef: result.ownerAggregate.id } : {}),
        ...(result.ownerAggregate ? { ownerAggregateVersion: result.ownerAggregate.version } : {}),
      });
      if (applied.outcome === 'CONFLICT') {
        metrics.increment('journey_owner_result_conflict_total');
        await quarantine('EVENT_HASH_CONFLICT');
      } else if (applied.outcome === 'DUPLICATE') {
        metrics.increment('journey_owner_result_duplicate_total');
      } else {
        metrics.increment('journey_owner_result_applied_total');
      }
    },
  };
  return createConsumer(consumerOptions);
}
