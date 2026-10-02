import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { resolve } from 'node:path';
import { PrismaClient } from '@d-contact/db';
import { createConsumer, createInMemoryIdempotencyStore, createProducer } from '@d-contact/kafka';
import {
  KAFKA_TOPICS,
  readS3Bucket,
  readS3Configuration,
  type TelephonyCommand,
} from '@d-contact/shared';
import { parseEslEvent } from './esl-event.js';
import { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';
import { DatabaseFreeSwitchVoiceTargetResolver } from './freeswitch-voice-target-resolver.js';
import {
  isDeniedAgentDirectOutbound,
  normalizeFreeSwitchEvent,
  parkedCallAsCreated,
} from './freeswitch-normalizer.js';
import { TelephonyRecordingLifecycle } from './recording-lifecycle.js';
import { S3RecordingArchive } from './s3-recording-archive.js';

const host = process.env.FREESWITCH_ESL_HOST ?? '127.0.0.1';
// Docker Compose exposes FreeSWITCH ESL on host port 8022; container-internal ESL remains 8021.
const port = Number(process.env.FREESWITCH_ESL_PORT ?? 8022);
const password = process.env.FREESWITCH_ESL_PASSWORD ?? 'ClueCon';
const nodeId = process.env.TELEPHONY_NODE_ID ?? 'fs-local';
const commandGroupId =
  process.env.TELEPHONY_COMMAND_GROUP_ID ?? `dcontact-telephony-command-${nodeId}-v1`;
const repositoryRoot = resolve(__dirname, '../../..');

async function main() {
  const database = new PrismaClient();
  const producer = await createProducer(`dcontact-telephony-${nodeId}`);
  const socket = net.createConnection({ host, port });
  socket.on('error', (error) => console.error('[telephony] ESL connection error', error));
  let buffer = '';
  let authenticated = false;
  const outboundBindingByCallUuid = new Map<
    string,
    { tenantId: string; deliveryId?: string; providerRequestKey?: string }
  >();
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
    undefined,
    {
      enabled: process.env.OUTBOUND_VOICE_DELIVERY_ENABLED === 'true',
      resolver: new DatabaseFreeSwitchVoiceTargetResolver(database),
      targetDialTemplate: process.env.FREESWITCH_VOICE_TARGET_DIAL_TEMPLATE,
      codecString: process.env.FREESWITCH_VOICE_CODEC_STRING,
    },
  );
  const recordingsDirectory =
    process.env.FREESWITCH_RECORDINGS_DIR ?? '/var/lib/freeswitch/recordings';
  const recordingLifecycle = new TelephonyRecordingLifecycle(
    database,
    commandAdapter,
    new S3RecordingArchive({
      bucket: readS3Bucket('RECORDINGS'),
      s3: readS3Configuration(),
      telephonyDirectory: recordingsDirectory,
      hostDirectory:
        process.env.FREESWITCH_RECORDINGS_HOST_DIR ??
        resolve(repositoryRoot, 'infra/docker/data/freeswitch-recordings'),
    }),
    recordingsDirectory,
  );
  const consumer = await createConsumer<TelephonyCommand>({
    clientId: `dcontact-telephony-${nodeId}`,
    groupId: commandGroupId,
    topics: [KAFKA_TOPICS.TELEPHONY_COMMANDS],
    idempotency: createInMemoryIdempotencyStore(),
    handler: async ({ event }) => commandAdapter.handle(event.payload, event.tenantId),
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
          'events plain CHANNEL_CREATE CHANNEL_PARK CHANNEL_BRIDGE CHANNEL_HANGUP_COMPLETE DTMF DETECTED_SPEECH BACKGROUND_JOB\n\n',
        );
        continue;
      }
      const parsed = parseEslEvent(frame);
      if (!parsed) continue;
      // #562: สายจาก trunk ได้ tenant ตอน park ไม่ใช่ตอน create — PARK อื่นไม่ใช่ call event
      const source =
        parsed['Event-Name'] === 'CHANNEL_PARK'
          ? parkedCallAsCreated(parsed, (callUuid) => outboundBindingByCallUuid.has(callUuid))
          : parsed;
      if (!source) continue;
      if (source['Event-Name'] === 'BACKGROUND_JOB') {
        const succeeded = typeof source.Body === 'string' && source.Body.startsWith('+OK');
        console.error('[telephony] FreeSWITCH background job', {
          jobUuid: source['Job-UUID'],
          ok: succeeded,
          reason: succeeded ? 'accepted' : 'rejected',
        });
        continue;
      }
      if (isDeniedAgentDirectOutbound(source)) continue;
      if (
        process.env.E1_18_VERBOSE &&
        (source.variable_dcontact_delivery_id || source.variable_dcontact_tenant_id)
      ) {
        console.error('[telephony] outbound event binding', {
          eventName: source['Event-Name'],
          callUuid: source['Unique-ID'],
          bridgeUuid: source['Bridge-A-Unique-ID'],
          tenantId: source.variable_dcontact_tenant_id,
          deliveryId: source.variable_dcontact_delivery_id,
          providerRequestKey: source.variable_dcontact_provider_request_key,
        });
      }
      try {
        const sipDomain = source.variable_domain_name;
        const sourceCallUuid =
          source['Event-Name'] === 'CHANNEL_BRIDGE' &&
          typeof source['Bridge-A-Unique-ID'] === 'string'
            ? source['Bridge-A-Unique-ID']
            : typeof source['Unique-ID'] === 'string'
              ? source['Unique-ID']
              : undefined;
        const knownBinding = sourceCallUuid
          ? outboundBindingByCallUuid.get(sourceCallUuid)
          : undefined;
        if (knownBinding) {
          source.variable_dcontact_tenant_id ??= knownBinding.tenantId;
          source.variable_dcontact_delivery_id ??= knownBinding.deliveryId;
          source.variable_dcontact_provider_request_key ??= knownBinding.providerRequestKey;
        }
        const outboundTenantId =
          typeof source.variable_dcontact_tenant_id === 'string' &&
          /^[0-9a-f-]{36}$/i.test(source.variable_dcontact_tenant_id)
            ? (
                await database.tenant.findUnique({
                  where: { id: source.variable_dcontact_tenant_id },
                  select: { id: true },
                })
              )?.id
            : undefined;
        const tenantId =
          outboundTenantId ??
          (typeof sipDomain === 'string'
            ? (
                await database.tenant.findUnique({
                  where: { sipDomain },
                  select: { id: true },
                })
              )?.id
            : sourceCallUuid
              ? outboundBindingByCallUuid.get(sourceCallUuid)?.tenantId
              : undefined);
        if (!tenantId) continue;
        const event = normalizeFreeSwitchEvent(source, {
          telephonyNodeId: nodeId,
          resolveTenantId: (domain) => (domain === sipDomain ? tenantId : undefined),
          resolveTenantIdForCall: (callUuid) =>
            outboundBindingByCallUuid.get(callUuid)?.tenantId ?? tenantId,
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
        if (event.type === 'call.created') {
          outboundBindingByCallUuid.set(event.payload.callUuid, {
            tenantId: event.tenantId,
            deliveryId: event.payload.deliveryId,
            providerRequestKey: event.payload.providerRequestKey,
          });
        }
        if (event.type === 'call.hangup') outboundBindingByCallUuid.delete(event.payload.callUuid);
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
