import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import {
  createJourneyFoundationPorts,
  createJourneyOutcomeTriggerPorts,
  createJourneyRealtimeGovernancePorts,
} from '@d-contact/journey-composition';
import { createDlqPublisher, createProducer } from '@d-contact/kafka';
import { EventInboxService } from './event-inbox.js';
import { createJourneyEventConsumer } from './journey-event-consumer.js';
import { createJourneyKafkaPublisher } from './journey-kafka-publisher.js';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';
import { createJourneyOutcomeConsumer } from './journey-outcome-consumer.js';
import { JourneyOutcomeTriggerProcessor } from './journey-outcome-trigger-processor.js';
import { JourneyProcessor } from './journey-processor.js';
import {
  JourneyGovernanceInvalidationService,
  createJourneyCanonicalRevalidator,
  createJourneyKafkaReconcilePort,
  createJourneyRealtimeSettlementPort,
} from './journey-governance-invalidation.js';
import { createJourneyGovernanceConsumer } from './journey-governance-consumer.js';
import { JourneyGovernanceAcknowledgementRelay } from './journey-governance-ack-relay.js';
import { JourneyGovernanceEffectRelay } from './journey-governance-effect-relay.js';
import { JsonJourneyGovernanceMetrics } from './journey-governance-metrics.js';

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} ต้องเป็นจำนวนเต็มบวก`);
  return value;
}

function configuredChannel(): 'EMAIL' | 'LINE' {
  const channel = process.env.JOURNEY_TRIGGER_CHANNEL ?? 'EMAIL';
  if (channel !== 'EMAIL' && channel !== 'LINE') {
    throw new Error('JOURNEY_TRIGGER_CHANNEL ต้องเป็น EMAIL หรือ LINE');
  }
  return channel;
}

function configuredTeamId(): string | undefined {
  const value = process.env.JOURNEY_TRIGGER_TEAM_ID?.trim();
  return value || undefined;
}

const database = new PrismaClient();
const producer = await createProducer('dcontact-journey-publisher');
const dlq = await createDlqPublisher('dcontact-journey-dlq');
const publisher = createJourneyKafkaPublisher(producer);
const inbox = new EventInboxService(database);
const processor = new JourneyProcessor(database, createJourneyFoundationPorts(database));
const realtimeGovernance = createJourneyRealtimeGovernancePorts(database);
const realtimeSettlement = createJourneyRealtimeSettlementPort(
  realtimeGovernance.settlement,
  createJourneyKafkaReconcilePort(producer),
);
const governanceMetrics = new JsonJourneyGovernanceMetrics();
const governanceInvalidation = new JourneyGovernanceInvalidationService(
  database,
  createJourneyCanonicalRevalidator(realtimeGovernance.revalidation),
  realtimeSettlement,
  {
    consumer: process.env.JOURNEY_GOVERNANCE_CONSUMER_GROUP_ID ?? 'dcontact-journey-cg3-v1',
    metrics: governanceMetrics,
  },
);
const governanceConsumer = await createJourneyGovernanceConsumer({
  database,
  service: governanceInvalidation,
  clientId: 'dcontact-journey-cg3-consumer',
  groupId: process.env.JOURNEY_GOVERNANCE_CONSUMER_GROUP_ID ?? 'dcontact-journey-cg3-v1',
  dlq,
});
const governanceAcknowledgements = new JourneyGovernanceAcknowledgementRelay(database, producer);
const governanceEffects = new JourneyGovernanceEffectRelay(database, realtimeSettlement, {
  metrics: governanceMetrics,
});
const journeyDefinitions = new JourneyDefinitionRepository(database, new DcExprEvaluator());
const outcomeTriggerProcessor = new JourneyOutcomeTriggerProcessor(
  database,
  journeyDefinitions,
  createJourneyOutcomeTriggerPorts(database),
);
const outcomeConsumer = await createJourneyOutcomeConsumer({
  database,
  clientId: 'dcontact-journey-outcome-consumer',
  groupId: process.env.JOURNEY_OUTCOME_CONSUMER_GROUP_ID ?? 'dcontact-journey-outcomes-v1',
  dlq,
});
const consumer = await createJourneyEventConsumer({
  database,
  processor,
  clientId: 'dcontact-journey-consumer',
  groupId: process.env.JOURNEY_CONSUMER_GROUP_ID ?? 'dcontact-journey-events-v1',
  dlq,
  definition: {
    journeyVersion: positiveInteger('JOURNEY_TRIGGER_VERSION', 1),
    stepId: process.env.JOURNEY_TRIGGER_STEP_ID ?? 'event-trigger',
    channel: configuredChannel(),
    purpose: process.env.JOURNEY_TRIGGER_PURPOSE ?? 'MARKETING',
    policyVersion: positiveInteger('JOURNEY_POLICY_VERSION', 1),
    teamId: configuredTeamId(),
  },
});
let draining = false;
let stopping = false;

async function drainInbox(): Promise<void> {
  if (draining || stopping) return;
  draining = true;
  try {
    const tenants = await database.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      for (let handled = 0; handled < 100; handled += 1) {
        const result = await inbox.publishNext(tenant.id, publisher);
        if (!result || result.state === 'FAILED') break;
      }
      await governanceEffects.observeReconcileBacklog(tenant.id);
      for (let handled = 0; handled < 100; handled += 1) {
        const result = await governanceEffects.executeNext(tenant.id);
        if (!result || result === 'RETRY') break;
      }
      for (let handled = 0; handled < 100; handled += 1) {
        const result = await governanceAcknowledgements.publishNext(tenant.id);
        if (!result || result.state === 'FAILED') break;
      }
      for (let handled = 0; handled < 100; handled += 1) {
        const result = await outcomeTriggerProcessor.executeNext(tenant.id, 'journey-main');
        if (!result) break;
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'journey.inbox.publish_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    draining = false;
  }
}

const timer = setInterval(() => void drainInbox(), 1_000);
void drainInbox();

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await Promise.all([
    consumer.disconnect(),
    outcomeConsumer.disconnect(),
    governanceConsumer.disconnect(),
    producer.disconnect(),
    dlq.disconnect(),
    database.$disconnect(),
  ]);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
