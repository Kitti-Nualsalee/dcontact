import { PrismaClient } from '@d-contact/db';
import {
  createDialerOwnerScopeAuthorizer,
  createDialerRealtimeGovernancePorts,
} from '@d-contact/dialer-composition';
import { createDlqPublisher, createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  DialerGovernanceInvalidationService,
  createDialerCanonicalRevalidator,
  createDialerRealtimeSettlementPort,
} from './dialer-governance.js';
import { DialerGovernanceAcknowledgementRelay } from './dialer-governance-ack-relay.js';
import { createDialerGovernanceConsumer } from './dialer-governance-consumer.js';
import { DialerGovernanceEffectRelay } from './dialer-governance-effect-relay.js';
import { JsonDialerGovernanceMetrics } from './dialer-governance-metrics.js';
import { createDialerOwnerCommandConsumer } from './dialer-owner-command-consumer.js';
import { DialerOwnerCommandService } from './dialer-owner-command-service.js';

const database = new PrismaClient();
const producer = await createProducer('dcontact-dialer-publisher');
const dlq = await createDlqPublisher('dcontact-dialer-dlq');
const governance = createDialerRealtimeGovernancePorts(database);
const metrics = new JsonDialerGovernanceMetrics();
const settlement = createDialerRealtimeSettlementPort(governance.settlement, {
  async requestReconcile(input) {
    await producer.send(KAFKA_TOPICS.DIALER_COMMANDS, {
      schemaVersion: 2,
      eventKind: 'COMMAND',
      eventId: `dialer-reconcile:${input.actionKey}`,
      type: 'dialer.reconcile_requested',
      tenantId: input.tenantId,
      occurredAt: new Date().toISOString(),
      correlationId: input.correlationId,
      orderingKey: input.actionKey,
      aggregateType: 'dialer_attempt',
      aggregateId: input.actionKey,
      aggregateVersion: 0,
      payload: {
        contractVersion: 1,
        actionKey: input.actionKey,
        reservationId: input.reservationId,
        deliveryId: input.deliveryId,
        providerRequestKey: input.providerRequestKey,
      },
    });
  },
});
const service = new DialerGovernanceInvalidationService(
  database,
  createDialerCanonicalRevalidator(governance.revalidation),
  {
    consumer: process.env.DIALER_GOVERNANCE_CONSUMER_GROUP_ID ?? 'dcontact-dialer-cg3-v1',
    metrics,
  },
);
const consumer = await createDialerGovernanceConsumer({
  database,
  service,
  clientId: 'dcontact-dialer-cg3-consumer',
  groupId: process.env.DIALER_GOVERNANCE_CONSUMER_GROUP_ID ?? 'dcontact-dialer-cg3-v1',
  dlq,
});
// J2.8 (#136): รับ owner command จาก Journey ทาง dc.dialer.commands และตอบผลกลับ dc.dialer.events
const ownerCommandConsumer = await createDialerOwnerCommandConsumer({
  owner: new DialerOwnerCommandService(database, createDialerOwnerScopeAuthorizer(database)),
  producer,
  clientId: 'dcontact-dialer-owner-command-consumer',
  groupId:
    process.env.DIALER_OWNER_COMMAND_CONSUMER_GROUP_ID ?? 'dcontact-dialer-owner-commands-v1',
  dlq,
});
const acknowledgements = new DialerGovernanceAcknowledgementRelay(database, producer);
const effects = new DialerGovernanceEffectRelay(database, settlement, { metrics });
let draining = false;
let stopping = false;

async function drain(): Promise<void> {
  if (draining || stopping) return;
  draining = true;
  try {
    for (const tenant of await database.tenant.findMany({ select: { id: true } })) {
      for (let count = 0; count < 100; count += 1) {
        const result = await effects.executeNext(tenant.id);
        if (!result || result === 'RETRY') break;
      }
      await effects.observeReconcileBacklog(tenant.id);
      for (let count = 0; count < 100; count += 1) {
        if (!(await acknowledgements.publishNext(tenant.id))) break;
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'dialer.governance.drain_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    draining = false;
  }
}

const timer = setInterval(() => void drain(), 1_000);
void drain();

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await Promise.all([
    consumer.disconnect(),
    ownerCommandConsumer.disconnect(),
    producer.disconnect(),
    dlq.disconnect(),
    database.$disconnect(),
  ]);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
