import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import { KAFKA_TOPICS, type TelephonyCommand } from '@d-contact/shared';
import {
  InboundVoiceRouter,
  ManagedVoiceRuntime,
  type ManagedVoiceDirectCommand,
} from '@d-contact/router';
import { runManagedVoiceDue, runManagedVoiceReadiness } from './managed-voice-due.js';
import { FreeSwitchManagedVoiceAdapter } from './managed-voice-adapter.js';
import { normalizeManagedVoiceEvent } from './managed-voice-events.js';
import { parseEslEvent } from './esl-event.js';
import { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';
import { DatabaseFreeSwitchVoiceTargetResolver } from './freeswitch-voice-target-resolver.js';
import { E1EslCommandClient } from './e1-esl-command-client.js';
import { DatabaseE1VoiceCommandAuthority } from '@d-contact/delivery';
import { createE1VoiceCommandServer } from './e1-voice-command-server.js';
import { E1VoiceOutcomes } from './e1-voice-outcomes.js';
import { E1BackgroundJobs } from './e1-background-jobs.js';
import { E1RegistrationFlusher } from './e1-registration-flush.js';
import {
  isDeniedAgentDirectOutbound,
  normalizeFreeSwitchEvent,
  parkedCallAsCreated,
  type FreeSwitchEvent,
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

export function e1CallSource(parsed: FreeSwitchEvent, isKnownCall: (callUuid: string) => boolean) {
  if (
    parsed['Event-Name'] === 'CHANNEL_CREATE' &&
    parsed['Call-Direction'] === 'inbound' &&
    parsed['Caller-Caller-ID-Number'] === '1102' &&
    parsed['Caller-Destination-Number'] === '1101' &&
    parsed.variable_dcontact_delivery_id === undefined
  )
    return undefined;
  return parsed['Event-Name'] === 'CHANNEL_PARK'
    ? parkedCallAsCreated(parsed, isKnownCall)
    : parsed;
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

  const databaseUrl = process.env.APPLICATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('APPLICATION_DATABASE_URL or DATABASE_URL is required');
  const database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const dispatchDatabase = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const socket = net.createConnection({ host, port });
  const knownCalls = new Map<string, string>();
  const voiceOutcomes = new E1VoiceOutcomes(database, voiceTenantId, nodeId);
  const outboundJobs = new E1BackgroundJobs((jobUuid, callUuid) =>
    voiceOutcomes.backgroundFailure(jobUuid, callUuid),
  );
  let authenticated = false;
  let subscribed = false;
  let stopping = false;
  let eventChain = Promise.resolve();
  let managedPortReady = false;
  let managedDueTask: Promise<void> = Promise.resolve();
  let managedReadinessTask: Promise<void> = Promise.resolve();
  let managedDispatchTask: Promise<void> = Promise.resolve();
  const managedBackgroundJobs = new Set<string>();
  const managedTenants = new Set<string>();
  async function clearManagedReadiness() {
    for (const tenantId of managedTenants) {
      await withTenantDatabaseTransaction(
        database,
        tenantId,
        (transaction) =>
          transaction.$executeRaw`UPDATE voice_managed_runtime_readiness
          SET direct_wired=false,expires_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=${tenantId}::uuid AND telephony_node_id=${nodeId}`,
      ).catch(() => console.error('[e1-sandbox] readiness clear failed; TTL expiry required'));
    }
  }
  const managedAdapter = new FreeSwitchManagedVoiceAdapter(
    new E1EslCommandClient({ host, port, password }),
    nodeId,
    process.env.FREESWITCH_SIP_DOMAIN ?? 'dcontact.local',
  );
  const managedRuntime = new ManagedVoiceRuntime(
    database,
    {
      readback: async (command: ManagedVoiceDirectCommand) => {
        if (!managedPortReady) throw new Error('MANAGED_VOICE_PORT_UNAVAILABLE');
        return managedAdapter.readback(command);
      },
      execute: async (command: ManagedVoiceDirectCommand) => {
        if (!managedPortReady) throw new Error('MANAGED_VOICE_PORT_UNAVAILABLE');
        await managedAdapter.bindCaller(command.tenantId, command.callUuid);
        return managedAdapter.execute(command);
      },
    },
    dispatchDatabase,
  );
  async function managedTenantIds() {
    return (
      await database.tenant.findMany({
        where: { lifecycleStatus: 'ACTIVE' },
        select: { id: true },
      })
    ).map((tenant) => {
      managedTenants.add(tenant.id);
      return tenant.id;
    });
  }
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
    registrations: new E1RegistrationFlusher(database, commandAdapter),
  });
  voiceServer.listen(3001, '0.0.0.0');
  const router = new InboundVoiceRouter(database, {
    publish: createE1SandboxPublisher(commandAdapter),
    eventId: randomUUID,
    now: () => new Date().toISOString(),
  });

  socket.on('error', (error) => console.error('[e1-sandbox] ESL error', error));
  socket.on('close', () => {
    subscribed = false;
    managedPortReady = false;
    if (!stopping) {
      clearInterval(dueTimer);
      clearInterval(readinessTimer);
      clearInterval(dispatchTimer);
      console.error('[e1-sandbox] ESL connection closed; restarting container');
      void managedReadinessTask.then(clearManagedReadiness).finally(() => process.exit(1));
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

  let processingLegacyDue = false;
  let processingManagedDue = false;
  const dueTimer = setInterval(() => {
    if (!processingLegacyDue) {
      processingLegacyDue = true;
      void router
        .processDue()
        .catch((error: unknown) => console.error('[e1-sandbox] legacy due-work failed', error))
        .finally(() => {
          processingLegacyDue = false;
        });
    }
    if (!processingManagedDue) {
      processingManagedDue = true;
      managedDueTask = runManagedVoiceDue({
        tenantIds: managedTenantIds,
        tick: (tenantId) => managedRuntime.tick(tenantId, nodeId),
        onError: (error) => console.error('[e1-sandbox] managed due-work failed', error),
      })
        .catch((error: unknown) => console.error('[e1-sandbox] DB due-work failed', error))
        .finally(() => {
          processingManagedDue = false;
        });
    }
  }, 1_000);
  dueTimer.unref();

  let processingReadiness = false;
  const readinessTimer = setInterval(() => {
    if (processingReadiness) return;
    processingReadiness = true;
    managedReadinessTask = runManagedVoiceReadiness({
      ready: () => (subscribed ? managedAdapter.ready() : Promise.resolve(false)),
      setPortReady: (ready) => {
        managedPortReady = ready && subscribed;
      },
      clearReadiness: clearManagedReadiness,
      tenantIds: managedTenantIds,
      heartbeat: (tenantId) =>
        subscribed && managedPortReady
          ? managedRuntime.heartbeat(tenantId, nodeId)
          : clearManagedReadiness(),
      onError: (error) => console.error('[e1-sandbox] readiness failed', error),
    })
      .catch(async (error: unknown) => {
        managedPortReady = false;
        console.error('[e1-sandbox] readiness failed', error);
        await clearManagedReadiness();
      })
      .finally(() => {
        processingReadiness = false;
      });
  }, 1000);
  readinessTimer.unref();

  let processingDispatch = false;
  const dispatchTimer = setInterval(() => {
    if (processingDispatch || !managedPortReady) return;
    processingDispatch = true;
    managedDispatchTask = (async () => {
      for (const jobUuid of [...managedBackgroundJobs].slice(0, 4)) {
        await managedAdapter.backgroundJob(jobUuid);
        managedBackgroundJobs.delete(jobUuid);
      }
      const tenantIds = [...managedTenants];
      for (let offset = 0; offset < tenantIds.length; offset += 4) {
        const results = await Promise.allSettled(
          tenantIds
            .slice(offset, offset + 4)
            .map((tenantId) => managedRuntime.flushCommands(tenantId, nodeId)),
        );
        for (const result of results)
          if (result.status === 'rejected')
            console.error('[e1-sandbox] managed dispatch failed', result.reason);
      }
    })()
      .catch((error: unknown) => console.error('[e1-sandbox] managed dispatch failed', error))
      .finally(() => {
        processingDispatch = false;
      });
  }, 1000);
  dispatchTimer.unref();

  async function handleFrame(frame: string) {
    if (!authenticated && /auth\/request/i.test(frame)) {
      socket.write(`auth ${password}\n\n`);
      return;
    }
    if (!authenticated && /\+OK accepted/i.test(frame)) {
      authenticated = true;
      socket.write(
        'events plain CHANNEL_CREATE CHANNEL_PARK CHANNEL_ANSWER CHANNEL_BRIDGE CHANNEL_HANGUP_COMPLETE BACKGROUND_JOB\n\n',
      );
      return;
    }
    if (authenticated && !subscribed && /Content-Type:\s*command\/reply/i.test(frame)) {
      if (!/Reply-Text:\s*\+OK/i.test(frame))
        throw new Error('MANAGED_VOICE_EVENT_SUBSCRIPTION_UNCONFIRMED');
      subscribed = true;
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
      ) {
        managedBackgroundJobs.add(jobUuid);
        await outboundJobs.completed(jobUuid, parsed.Body.startsWith('+OK'));
      }
      return;
    }
    const source = e1CallSource(parsed, (callUuid) => knownCalls.has(callUuid));
    if (!source || isDeniedAgentDirectOutbound(source)) return;
    if (typeof source.variable_dcontact_offer_id === 'string') {
      const tenantId = source.variable_dcontact_tenant_id;
      if (typeof tenantId !== 'string') return;
      const managedEvent = normalizeManagedVoiceEvent(source, tenantId, nodeId);
      if (managedEvent) {
        await managedRuntime.handle(managedEvent);
        if (managedEvent.type === 'call.hangup' && !managedEvent.offerId)
          knownCalls.delete(managedEvent.callUuid);
      }
      return;
    }
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
    if (!outboundBinding) {
      const managedEvent = normalizeManagedVoiceEvent(source, tenantId, nodeId);
      if (managedEvent) {
        const handled = await managedRuntime.handle(managedEvent);
        if (handled) {
          if (managedEvent.type === 'call.created') knownCalls.set(callUuid, tenantId);
          if (managedEvent.type === 'call.hangup') knownCalls.delete(callUuid);
          return;
        }
      }
    }
    if (source['Event-Name'] === 'CHANNEL_ANSWER') return;
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
    clearInterval(readinessTimer);
    clearInterval(dispatchTimer);
    subscribed = false;
    managedPortReady = false;
    await Promise.allSettled([managedDueTask, managedReadinessTask, managedDispatchTask]);
    await clearManagedReadiness();
    socket.destroy();
    voiceServer.closeAllConnections();
    await new Promise<void>((resolve) => voiceServer.close(() => resolve()));
    await Promise.all([database.$disconnect(), dispatchDatabase.$disconnect()]);
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
