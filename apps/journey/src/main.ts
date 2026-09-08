import { ContactGovernanceService } from '@d-contact/contact-governance';
import { PrismaClient } from '@d-contact/db';
import { createProducer } from '@d-contact/kafka';
import { EventInboxService } from './event-inbox.js';
import { createJourneyEventConsumer } from './journey-event-consumer.js';
import { createJourneyKafkaPublisher } from './journey-kafka-publisher.js';
import { JourneyProcessor } from './journey-processor.js';

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

const database = new PrismaClient();
const producer = await createProducer('dcontact-journey-publisher');
const publisher = createJourneyKafkaPublisher(producer);
const inbox = new EventInboxService(database);
const processor = new JourneyProcessor(database, new ContactGovernanceService(database));
const consumer = await createJourneyEventConsumer({
  database,
  processor,
  clientId: 'dcontact-journey-consumer',
  groupId: process.env.JOURNEY_CONSUMER_GROUP_ID ?? 'dcontact-journey-events-v1',
  definition: {
    journeyVersion: positiveInteger('JOURNEY_TRIGGER_VERSION', 1),
    stepId: process.env.JOURNEY_TRIGGER_STEP_ID ?? 'event-trigger',
    channel: configuredChannel(),
    purpose: process.env.JOURNEY_TRIGGER_PURPOSE ?? 'MARKETING',
    policyVersion: positiveInteger('JOURNEY_POLICY_VERSION', 1),
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
  await Promise.all([consumer.disconnect(), producer.disconnect(), database.$disconnect()]);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
