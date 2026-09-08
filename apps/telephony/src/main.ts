import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { resolve } from 'node:path';
import { PrismaClient } from '@d-contact/db';
import { createConsumer, createInMemoryIdempotencyStore, createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS, type TelephonyCommand } from '@d-contact/shared';
import { parseEslEvent } from './esl-event.js';
import { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';
import { normalizeFreeSwitchEvent } from './freeswitch-normalizer.js';
import { TelephonyRecordingLifecycle } from './recording-lifecycle.js';
import { MinioRecordingArchive } from './minio-recording-archive.js';

const host = process.env.FREESWITCH_ESL_HOST ?? '127.0.0.1';
const port = Number(process.env.FREESWITCH_ESL_PORT ?? 8021);
const password = process.env.FREESWITCH_ESL_PASSWORD ?? 'ClueCon';
const nodeId = process.env.TELEPHONY_NODE_ID ?? 'fs-local';
const repositoryRoot = resolve(__dirname, '../../..');

async function main() {
  const database = new PrismaClient();
  const producer = await createProducer(`dcontact-telephony-${nodeId}`);
  const socket = net.createConnection({ host, port });
  socket.on('error', (error) => console.error('[telephony] ESL connection error', error));
  let buffer = '';
  let authenticated = false;
  const tenantIdByCallUuid = new Map<string, string>();
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
  const recordingsDirectory =
    process.env.FREESWITCH_RECORDINGS_DIR ?? '/var/lib/freeswitch/recordings';
  const recordingLifecycle = new TelephonyRecordingLifecycle(
    database,
    commandAdapter,
    new MinioRecordingArchive({
      bucket: process.env.S3_BUCKET_RECORDINGS ?? process.env.RECORDINGS_BUCKET ?? 'recordings',
      endpoint: process.env.S3_ENDPOINT ?? process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
      accessKeyId: process.env.S3_ACCESS_KEY ?? process.env.MINIO_ACCESS_KEY ?? 'dcontact',
      secretAccessKey:
        process.env.S3_SECRET_KEY ?? process.env.MINIO_SECRET_KEY ?? 'dcontact-secret',
      region: process.env.S3_REGION ?? process.env.MINIO_REGION ?? 'us-east-1',
      telephonyDirectory: recordingsDirectory,
      // resolve เทียบ repository root เสมอ: service ถูกสตาร์ทด้วย `pnpm --filter` ซึ่ง cwd คือ
      // apps/telephony ค่าสัมพัทธ์จึงเคยชี้ไปยัง apps/telephony/infra/... ที่ไม่มีไฟล์อยู่จริง
      // ทำให้ recording ไม่ถูก archive; ค่าที่เป็น absolute อยู่แล้วจะถูกใช้ตามเดิม
      hostDirectory: resolve(
        repositoryRoot,
        process.env.FREESWITCH_RECORDINGS_HOST_DIR ?? 'infra/docker/data/freeswitch-recordings',
      ),
    }),
    recordingsDirectory,
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
        socket.write(
          'events plain CHANNEL_CREATE CHANNEL_BRIDGE CHANNEL_HANGUP_COMPLETE DTMF DETECTED_SPEECH\n\n',
        );
        continue;
      }
      const source = parseEslEvent(frame);
      if (!source) continue;
      try {
        const sipDomain = source.variable_domain_name;
        const sourceCallUuid =
          typeof source['Unique-ID'] === 'string' ? source['Unique-ID'] : undefined;
        const tenantId =
          typeof sipDomain === 'string'
            ? (
                await database.tenant.findUnique({
                  where: { sipDomain },
                  select: { id: true },
                })
              )?.id
            : sourceCallUuid
              ? tenantIdByCallUuid.get(sourceCallUuid)
              : undefined;
        if (!tenantId) continue;
        const event = normalizeFreeSwitchEvent(source, {
          telephonyNodeId: nodeId,
          resolveTenantId: (domain) => (domain === sipDomain ? tenantId : undefined),
          resolveTenantIdForCall: (callUuid) => tenantIdByCallUuid.get(callUuid),
          eventId: randomUUID,
          now: () => new Date().toISOString(),
        });
        if (event.type === 'call.hangup') {
          try {
            await recordingLifecycle.finishForHungupCall(event);
          } catch (error) {
            console.error('[telephony] recording archive deferred', error);
          }
        } else {
          await recordingLifecycle.startForAnsweredCall(event);
        }
        await producer.send(KAFKA_TOPICS.TELEPHONY_EVENTS, event);
        if (event.type === 'call.created')
          tenantIdByCallUuid.set(event.payload.callUuid, event.tenantId);
        if (event.type === 'call.hangup') tenantIdByCallUuid.delete(event.payload.callUuid);
      } catch (error) {
        console.error('[telephony] ignored ESL event', error);
      }
    }
  });
  const archiveRetryTimer = setInterval(() => {
    void recordingLifecycle.retryPendingArchives(nodeId).catch((error: unknown) => {
      console.error('[telephony] recording archive retry failed', error);
    });
  }, 5_000);
  archiveRetryTimer.unref();
  const shutdown = async () => {
    clearInterval(archiveRetryTimer);
    socket.removeAllListeners('data');
    socket.end();
    await Promise.all([consumer.disconnect(), producer.disconnect(), database.$disconnect()]);
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
void main();
