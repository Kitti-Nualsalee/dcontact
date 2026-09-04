import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@d-contact/db';
import { createConsumer, createInMemoryIdempotencyStore, createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS, type TelephonyCallEvent } from '@d-contact/shared';
import { InboundVoiceRouter } from './inbound-voice-router.js';

async function main() {
  const database = new PrismaClient();
  const producer = await createProducer('dcontact-router');
  const router = new InboundVoiceRouter(database, {
    publish: (topic, event) => producer.send(topic, event),
    eventId: randomUUID,
    now: () => new Date().toISOString(),
  });
  const consumer = await createConsumer<TelephonyCallEvent>({
    clientId: 'dcontact-router',
    groupId: process.env.ROUTER_INBOUND_VOICE_GROUP_ID ?? 'dcontact-router-inbound-voice-v1',
    topics: [KAFKA_TOPICS.TELEPHONY_EVENTS],
    idempotency: createInMemoryIdempotencyStore(),
    handler: async ({ event }) => {
      if (
        event.type === 'call.created' ||
        event.type === 'call.answered' ||
        event.type === 'call.hangup' ||
        event.type === 'call.input'
      ) {
        await router.handle(event);
      }
    },
  });
  const dueTimer = setInterval(() => {
    void router.processDue().catch((error: unknown) => {
      console.error('router due-work failed', error);
    });
  }, 1_000);
  dueTimer.unref();
  const shutdown = async () => {
    clearInterval(dueTimer);
    await Promise.all([consumer.disconnect(), producer.disconnect(), database.$disconnect()]);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main();
