import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { PrismaClient } from '@d-contact/db';
import { createConsumer, createInMemoryIdempotencyStore, createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS, type TelephonyCommand } from '@d-contact/shared';
import { parseEslEvent } from './esl-event.js';
import { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';
import { normalizeFreeSwitchEvent } from './freeswitch-normalizer.js';

const host = process.env.FREESWITCH_ESL_HOST ?? '127.0.0.1';
const port = Number(process.env.FREESWITCH_ESL_PORT ?? 8021);
const password = process.env.FREESWITCH_ESL_PASSWORD ?? 'ClueCon';
const nodeId = process.env.TELEPHONY_NODE_ID ?? 'fs-local';

async function main() {
  const database = new PrismaClient();
  const producer = await createProducer(`dcontact-telephony-${nodeId}`);
  const socket = net.createConnection({ host, port });
  socket.on('error', (error) => console.error('[telephony] ESL connection error', error));
  let buffer = '';
  let authenticated = false;
  const commandAdapter = new FreeSwitchCommandAdapter(
    {
      command: async (command) => {
        await new Promise<void>((resolve, reject) =>
          socket.write(`${command}\n\n`, (error) => (error ? reject(error) : resolve())),
        );
      },
    },
    process.env.FREESWITCH_SIP_DOMAIN ?? 'dcontact.local',
    nodeId,
  );
  const consumer = await createConsumer<TelephonyCommand>({
    clientId: `dcontact-telephony-${nodeId}`,
    groupId: `dcontact-telephony-command-${nodeId}-v1`,
    topics: [KAFKA_TOPICS.TELEPHONY_COMMANDS],
    idempotency: createInMemoryIdempotencyStore(),
    handler: async ({ event }) => commandAdapter.handle(event.payload),
  });
  socket.on('data', async (chunk: Buffer) => {
    buffer += chunk.toString();
    while (true) {
      const separator = buffer.search(/\r?\n\r?\n/);
      if (separator < 0) return;
      const header = buffer.slice(0, separator);
      const length = Number(/^Content-Length:\s*(\d+)$/im.exec(header)?.[1] ?? 0);
      const separatorLength = buffer.startsWith('\r\n', separator) ? 4 : 2;
      if (buffer.length < separator + separatorLength + length) return;
      const frame = buffer.slice(0, separator + separatorLength + length);
      buffer = buffer.slice(separator + separatorLength + length);
      if (!authenticated && /auth\/request/i.test(header)) {
        socket.write(`auth ${password}\n\n`);
        continue;
      }
      if (!authenticated && /\+OK accepted/i.test(frame)) {
        authenticated = true;
        socket.write('events plain CHANNEL_CREATE CHANNEL_BRIDGE CHANNEL_HANGUP_COMPLETE\n\n');
        continue;
      }
      const source = parseEslEvent(frame);
      if (!source) continue;
      try {
        const sipDomain = source.variable_domain_name;
        if (typeof sipDomain !== 'string') continue;
        const tenant = await database.tenant.findUnique({
          where: { sipDomain },
          select: { id: true },
        });
        if (!tenant) continue;
        const event = normalizeFreeSwitchEvent(source, {
          telephonyNodeId: nodeId,
          resolveTenantId: (domain) => (domain === sipDomain ? tenant.id : undefined),
          eventId: randomUUID,
          now: () => new Date().toISOString(),
        });
        await producer.send(KAFKA_TOPICS.TELEPHONY_EVENTS, event);
      } catch (error) {
        console.error('[telephony] ignored ESL event', error);
      }
    }
  });
  const shutdown = async () => {
    await Promise.all([consumer.disconnect(), producer.disconnect(), database.$disconnect()]);
    socket.end();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
void main();
