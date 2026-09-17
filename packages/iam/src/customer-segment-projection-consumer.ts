import {
  assertSegmentMembershipChangeEnvelope,
  type SegmentMembershipChangePayloadV1,
} from '@d-contact/cxa-contracts';
import {
  createConsumer,
  type CreateConsumerOptions,
  type DcConsumer,
  type DlqPublisher,
  type EventIdempotencyStore,
} from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { IamTeamSegmentScopeRepository } from './team-segment-scope-repository.js';

export interface CreateIamCustomerSegmentProjectionConsumerOptions {
  repository: IamTeamSegmentScopeRepository;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
}

/** The repository commits projection and durable inbox in one tenant transaction. */
function durableRepositoryIdempotency(): EventIdempotencyStore {
  return {
    durability: 'DURABLE',
    async execute(_key, work) {
      await work(undefined);
      return 'processed';
    },
  };
}

export function createIamCustomerSegmentProjectionConsumer(
  options: CreateIamCustomerSegmentProjectionConsumerOptions,
): Promise<DcConsumer> {
  const consumerOptions: CreateConsumerOptions<SegmentMembershipChangePayloadV1, undefined> = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.CUSTOMER_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: durableRepositoryIdempotency(),
    handler: async ({ event }) => {
      const envelope = assertSegmentMembershipChangeEnvelope(event);
      await options.repository.applyMembershipChange({
        tenantId: envelope.tenantId,
        eventId: envelope.eventId,
        occurredAt: envelope.occurredAt,
        consumerGroup: options.groupId,
        payload: envelope.payload,
      });
    },
  };
  return createConsumer(consumerOptions);
}
