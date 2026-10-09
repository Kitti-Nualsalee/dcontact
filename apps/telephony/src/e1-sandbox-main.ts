import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { PrismaClient } from '@d-contact/db';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import { KAFKA_TOPICS, type TelephonyCommand } from '@d-contact/shared';
import { InboundVoiceRouter } from '@d-contact/router';
import { parseEslEvent } from './esl-event.js';
import { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';
import { DatabaseFreeSwitchVoiceTargetResolver } from './freeswitch-voice-target-resolver.js';
import { E1EslCommandClient } from './e1-esl-command-client.js';
import { DatabaseE1VoiceCommandAuthority } from '@d-contact/delivery';
import { createE1VoiceCommandServer } from './e1-voice-command-server.js';
import { E1VoiceOutcomes } from './e1-voice-outcomes.js';
import { E1BackgroundJobs } from './e1-background-jobs.js';
import {
  isDeniedAgentDirectOutbound,
  normalizeFreeSwitchEvent,
  parkedCallAsCreated,
} from './freeswitch-normalizer.js';

const enabled = process.env.E1_SANDBOX_ENABLED === 'true';
const host = process.env.FREESWITCH_ESL_HOST ?? 'freeswitch';
const port = Number(process.env.FREESWITCH_ESL_PORT ?? '8021');
const password = process.env.FREESWITCH_ESL_PASSWORD;
const nodeId = process.env.TELEPHONY_NODE_ID ?? 'e1-sandbox';

type Publisher = (
  topic: (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS],
  event: KafkaEventEnvelope<Record<string, unknown>>,
) => Promise<void>;

export function createE1SandboxPublisher(adapter: FreeSwitchCommandAdapter): Publisher {
  return async (topic, event) => {
    if (topic !== KAFKA_TOPICS.TELEPHONY_COMMANDS) return;
    await adapter.handle(event.payload as TelephonyCommand, event.tenantId);
  };
}

function frames(onFrame: (frame: string) => void) {
  let buffer = '';
  return (chunk: Buffer) => {
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
      onFrame(frame);
    }
  };
}

async function main() {
  if (!enabled) throw new Error('E1_SANDBOX_ENABLED=true is required');
  if (!password) throw new Error('FREESWITCH_ESL_PASSWORD is required');
  const voiceTenantId = process.env.E1_VOICE_TENANT_ID ?? '';
  const voiceSecret = process.env.E1_VOICE_COMMAND_SECRET ?? '';

  const database = new PrismaClient();
  const socket = net.createConnection({ host, port });
  const knownCalls = new Map<string, string>();
  const voiceOutcomes = new E1VoiceOutcomes(database, voiceTenantId, nodeId);
  const outboundJobs = new E1BackgroundJobs((jobUuid, callUuid) =>
    voiceOutcomes.backgroundFailure(jobUuid, callUuid),
  );
  let authenticated = false;
  let stopping = false;
  let eventChain = Promise.resolve();
  const commandAdapter = new FreeSwitchCommandAdapter(
    new E1EslCommandClient({
      host,
      port,
      password,
      onBackgroundJob: (jobUuid, command) => {
        const callUuid = /origination_uuid=([0-9a-f-]{36})/i.exec(command)?.[1];
        if (callUuid)
          void outboundJobs
            .accepted(jobUuid, callUuid)
            .catch(() => console.error('[e1-sandbox] background outcome requires reconciliation'));
      },
    }),
    process.env.FREESWITCH_SIP_DOMAIN,
    nodeId,
    'user/{extension}@{domain}',
    {
      enabled: true,
      resolver: new DatabaseFreeSwitchVoiceTargetResolver(database),
      targetDialTemplate: 'user/{extension}@{domain}',
    },
  );
  const voiceServer = createE1VoiceCommandServer({
    secret: voiceSecret,
    tenantId: voiceTenantId,
    nodeId,
    authority: {
      claim: (input) =>
        input.command.type === 'call.cancel' ||
        process.env.OUTBOUND_VOICE_DELIVERY_ENABLED === 'true'
          ? new DatabaseE1VoiceCommandAuthority(database).claim(input)
          : Promise.resolve(false),
    },
    adapter: commandAdapter,
  });
  voiceServer.listen(3001, '0.0.0.0');
  const router = new InboundVoiceRouter(database, {
    publish: createE1SandboxPublisher(commandAdapter),
    eventId: randomUUID,
    now: () => new Date().toISOString(),
  });

  socket.on('error', (error) => console.error('[e1-sandbox] ESL error', error));
  socket.on('close', () => {
    if (!stopping) {
      console.error('[e1-sandbox] ESL connection closed; restarting container');
      process.exit(1);
    }
  });
  socket.on(
    'data',
    frames((frame) => {
      eventChain = eventChain
        .then(() => handleFrame(frame))
        .catch((error: unknown) => console.error('[e1-sandbox] ignored FreeSWITCH event', error));
    }),
  );

  const dueTimer = setInterval(() => {
    void router
      .processDue()
      .catch((error: unknown) => console.error('[e1-sandbox] due-work failed', error));
  }, 1_000);
  dueTimer.unref();

  async function handleFrame(frame: string) {
    if (!authenticated && /auth\/request/i.test(frame)) {
      socket.write(`auth ${password}\n\n`);
      return;
    }
    if (!authenticated && /\+OK accepted/i.test(frame)) {
      authenticated = true;
      socket.write(
        'events plain CHANNEL_CREATE CHANNEL_PARK CHANNEL_BRIDGE CHANNEL_HANGUP_COMPLETE BACKGROUND_JOB\n\n',
      );
      return;
    }
    const parsed = parseEslEvent(frame);
    if (!parsed) return;
    if (parsed['Event-Name'] === 'BACKGROUND_JOB') {
      const jobUuid = parsed['Job-UUID'];
      if (
        typeof jobUuid === 'string' &&
        typeof parsed.Body === 'string' &&
        /^(?:\+OK|-ERR)/.test(parsed.Body)
      )
        await outboundJobs.completed(jobUuid, parsed.Body.startsWith('+OK'));
      return;
    }
    const source =
      parsed['Event-Name'] === 'CHANNEL_PARK'
        ? parkedCallAsCreated(parsed, (callUuid) => knownCalls.has(callUuid))
        : parsed;
    if (!source || isDeniedAgentDirectOutbound(source)) return;
    const callUuid =
      source['Event-Name'] === 'CHANNEL_BRIDGE'
        ? source['Bridge-A-Unique-ID']
        : source['Unique-ID'];
    if (typeof callUuid !== 'string') return;
    const outboundBinding = await voiceOutcomes.binding(callUuid);
    if (outboundBinding) {
      source.variable_dcontact_delivery_id = outboundBinding.deliveryId;
      source.variable_dcontact_provider_request_key = outboundBinding.providerRequestKey;
      knownCalls.set(callUuid, outboundBinding.tenantId);
    } else if (source.variable_dcontact_delivery_id) {
      return;
    }
    const sipDomain = source.variable_domain_name;
    const tenantIdFromDomain =
      typeof sipDomain === 'string'
        ? (await database.tenant.findUnique({ where: { sipDomain }, select: { id: true } }))?.id
        : undefined;
    const tenantId = outboundBinding?.tenantId ?? tenantIdFromDomain ?? knownCalls.get(callUuid);
    if (!tenantId) return;
    const event = normalizeFreeSwitchEvent(source, {
      telephonyNodeId: nodeId,
      resolveTenantId: (domain) => (domain === sipDomain ? tenantId : undefined),
      resolveTenantIdForCall: (knownCallUuid) => knownCalls.get(knownCallUuid),
      eventId: randomUUID,
      now: () => new Date().toISOString(),
    });
    await voiceOutcomes.handle(event);
    await router.handle(event);
    if (event.type === 'call.created') knownCalls.set(event.payload.callUuid, event.tenantId);
    if (event.type === 'call.hangup') knownCalls.delete(event.payload.callUuid);
  }

  const shutdown = async () => {
    stopping = true;
    clearInterval(dueTimer);
    socket.destroy();
    voiceServer.closeAllConnections();
    await new Promise<void>((resolve) => voiceServer.close(() => resolve()));
    await database.$disconnect();
  };
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error('[e1-sandbox] startup failed', error);
    process.exitCode = 1;
  });
}
