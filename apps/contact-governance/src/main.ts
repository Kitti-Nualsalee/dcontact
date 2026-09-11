import { PrismaClient } from '@d-contact/db';
import { createDlqPublisher, createProducer } from '@d-contact/kafka';
import { Redis } from 'ioredis';
import { createCg3AcknowledgementConsumer } from './cg3-acknowledgement-consumer.js';
import { Cg3Cache } from './cg3-cache.js';
import { Cg3EventRelay } from './cg3-event-relay.js';

const database = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const cache = new Cg3Cache(redis);
const producer = await createProducer('dcontact-contact-governance-publisher');
const dlq = await createDlqPublisher('dcontact-contact-governance-dlq');
const relay = new Cg3EventRelay(database, producer, { cache });
const consumer = await createCg3AcknowledgementConsumer({
  database,
  clientId: 'dcontact-contact-governance-consumer',
  groupId: process.env.CG3_ACKNOWLEDGEMENT_CONSUMER_GROUP_ID ?? 'dcontact-cg3-acknowledgements-v1',
  dlq,
});

let draining = false;
let stopping = false;

async function drainOutbox(): Promise<void> {
  if (draining || stopping) return;
  draining = true;
  try {
    const tenants = await database.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      for (let handled = 0; handled < 100; handled += 1) {
        const result = await relay.publishNext(tenant.id);
        if (!result || result.state === 'FAILED') break;
      }
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'contact_governance.outbox.publish_failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    draining = false;
  }
}

const timer = setInterval(() => void drainOutbox(), 1_000);
void drainOutbox();

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await Promise.all([
    consumer.disconnect(),
    producer.disconnect(),
    dlq.disconnect(),
    database.$disconnect(),
    redis.quit(),
  ]);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
