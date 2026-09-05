import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@d-contact/db';
import { createProducer } from '@d-contact/kafka';
import { InboundVoiceRouter } from './inbound-voice-router.js';

async function main(): Promise<void> {
  const [tenantId, interactionId, agentId, code = 'DEMO_RESOLVED'] = process.argv
    .slice(2)
    .filter((argument) => argument !== '--');
  if (!tenantId || !interactionId || !agentId) {
    throw new Error('demo wrap-up requires tenantId, interactionId and agentId');
  }

  const database = new PrismaClient();
  const producer = await createProducer(`dcontact-router-demo-wrapup-${process.pid}`);
  try {
    const router = new InboundVoiceRouter(database, {
      publish: (topic, event) => producer.send(topic, event),
      eventId: randomUUID,
      now: () => new Date().toISOString(),
    });
    const result = await router.completeWrapUp({ tenantId, interactionId, agentId, code });
    if (result.status !== 'COMPLETED') {
      throw new Error(`demo wrap-up did not complete interaction: ${result.status}`);
    }
  } finally {
    await Promise.all([producer.disconnect(), database.$disconnect()]);
  }
}

void main();
