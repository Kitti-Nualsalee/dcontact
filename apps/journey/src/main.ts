import { PrismaClient } from '@d-contact/db';
import { createProducer } from '@d-contact/kafka';
import { EventInboxService } from './event-inbox.js';
import { createJourneyKafkaPublisher } from './journey-kafka-publisher.js';

const database = new PrismaClient();
const producer = await createProducer('dcontact-journey-publisher');
const publisher = createJourneyKafkaPublisher(producer);
const inbox = new EventInboxService(database);
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
  await Promise.all([producer.disconnect(), database.$disconnect()]);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
