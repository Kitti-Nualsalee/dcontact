/**
 * Owner: Delivery/Channels — composition root ของ process LINE webhook (S2.5 #369)
 *
 * ไฟล์นี้เป็นที่เดียวใน production path ที่รู้ concrete `ContactGovernanceService` (แบบเดียวกับ
 * `packages/dialer-composition`) — ingress/worker เห็นแค่ `ContactTouchCorrelationPort`
 *
 * fail closed ตั้งแต่ start:
 * - binding ผูกได้เฉพาะ test OA ของ S2 (Channel ID `2007056595`) — ค่าอื่นไม่ start (#359 CONFIRMED:
 *   singleton route ห้ามนำไปใช้กับ production/multi-account)
 * - secret ทุกตัวอ่านจาก Keychain; env มีได้แค่ชื่อ service ไม่ใช่ค่า secret
 * - กุญแจ payload ต้องเป็น 32 bytes (base64) ไม่งั้นไม่ start
 */
import type { Server } from 'node:http';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import { LINE_PILOT_CHANNEL_ID } from '@d-contact/cxa-contracts';
import type { PrismaClient } from '@d-contact/db';
import type { LineKeychainReference, LineSecretSource } from './line-credential-boundary.js';
import { LineInboundRepository } from './line-inbound-repository.js';
import { LinePostbackTokenCodec } from './line-postback-token.js';
import { StaticLinePayloadKeyring } from './line-protected-payload.js';
import { LineWebhookIngress } from './line-webhook-ingress.js';
import { LineWebhookRepository } from './line-webhook-repository.js';
import { createLineWebhookServer } from './line-webhook-server.js';
import { LineChannelSecret } from './line-webhook-signature.js';
import { LineWebhookWorker, type LineWebhookEventSink } from './line-webhook-worker.js';

export interface LineWebhookRuntimeConfig {
  tenantId: string;
  channelAccountId: string;
  expectedDestination: string;
  port: number;
  channelSecret: LineKeychainReference;
  payloadKey: LineKeychainReference;
  /** ไม่ตั้ง = postback ไม่ถูกนับเป็น response จนกว่าจะมี approved signed-postback template */
  postbackKey?: LineKeychainReference;
  pollIntervalMs: number;
}

export class LineWebhookRuntimeConfigError extends Error {
  constructor(readonly field: string) {
    super(`config ของ LINE webhook ไม่ถูกต้อง: ${field}`);
    this.name = 'LineWebhookRuntimeConfigError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESTINATION = /^U[0-9a-f]{32}$/;

/** อ่านเฉพาะค่าที่ไม่ใช่ความลับจาก env — secret ถูกอ้างด้วยชื่อ Keychain service เท่านั้น */
export function lineWebhookConfigFromEnv(env: NodeJS.ProcessEnv): LineWebhookRuntimeConfig {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new LineWebhookRuntimeConfigError(name);
    return value;
  };
  const account = env.LINE_KEYCHAIN_ACCOUNT ?? '';
  const config: LineWebhookRuntimeConfig = {
    tenantId: required('LINE_WEBHOOK_TENANT_ID'),
    channelAccountId: required('LINE_CHANNEL_ID'),
    expectedDestination: required('LINE_WEBHOOK_DESTINATION'),
    port: Number(env.LINE_WEBHOOK_PORT ?? '8787'),
    channelSecret: {
      keychainService: required('LINE_CHANNEL_SECRET_KEYCHAIN_SERVICE'),
      keychainAccount: account,
    },
    payloadKey: {
      keychainService: required('LINE_WEBHOOK_PAYLOAD_KEY_KEYCHAIN_SERVICE'),
      keychainAccount: account,
    },
    ...(env.LINE_POSTBACK_KEY_KEYCHAIN_SERVICE
      ? {
          postbackKey: {
            keychainService: env.LINE_POSTBACK_KEY_KEYCHAIN_SERVICE,
            keychainAccount: account,
          },
        }
      : {}),
    pollIntervalMs: Number(env.LINE_WEBHOOK_POLL_MS ?? '1000'),
  };
  assertSingletonBinding(config);
  return config;
}

export function assertSingletonBinding(config: LineWebhookRuntimeConfig): void {
  if (!UUID.test(config.tenantId)) throw new LineWebhookRuntimeConfigError('tenantId');
  if (config.channelAccountId !== LINE_PILOT_CHANNEL_ID) {
    throw new LineWebhookRuntimeConfigError('channelAccountId');
  }
  if (!DESTINATION.test(config.expectedDestination)) {
    throw new LineWebhookRuntimeConfigError('expectedDestination');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new LineWebhookRuntimeConfigError('port');
  }
  if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 100) {
    throw new LineWebhookRuntimeConfigError('pollIntervalMs');
  }
}

function decodeKey(value: string, field: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new LineWebhookRuntimeConfigError(field);
  return key;
}

export interface LineWebhookRuntime {
  server: Server;
  worker: LineWebhookWorker;
  stop(): Promise<void>;
}

export async function startLineWebhookRuntime(
  config: LineWebhookRuntimeConfig,
  dependencies: {
    database: PrismaClient;
    secrets: LineSecretSource;
    events?: LineWebhookEventSink;
    log?: (entry: object) => void;
  },
): Promise<LineWebhookRuntime> {
  assertSingletonBinding(config);
  const [channelSecret, payloadKey, postbackKey] = await Promise.all([
    dependencies.secrets.read(config.channelSecret),
    dependencies.secrets.read(config.payloadKey),
    config.postbackKey ? dependencies.secrets.read(config.postbackKey) : Promise.resolve(undefined),
  ]);
  const keyring = new StaticLinePayloadKeyring(
    1,
    new Map([[1, decodeKey(payloadKey, 'payloadKey')]]),
  );

  const webhooks = new LineWebhookRepository(dependencies.database);
  const ingress = new LineWebhookIngress({
    binding: {
      tenantId: config.tenantId,
      channelAccountId: config.channelAccountId,
      expectedDestination: config.expectedDestination,
      secret: new LineChannelSecret(channelSecret),
    },
    repository: webhooks,
    keyring,
  });
  const worker = new LineWebhookWorker({
    tenantId: config.tenantId,
    channelAccountId: config.channelAccountId,
    webhooks,
    inbound: new LineInboundRepository(dependencies.database),
    keyring,
    governance: new ContactGovernanceService(dependencies.database),
    ...(dependencies.events ? { events: dependencies.events } : {}),
    ...(postbackKey
      ? { postbackTokens: new LinePostbackTokenCodec(decodeKey(postbackKey, 'postbackKey')) }
      : {}),
  });

  const server = createLineWebhookServer({
    ingress,
    ...(dependencies.log ? { log: dependencies.log } : {}),
  });
  await new Promise<void>((resolve) => server.listen(config.port, '127.0.0.1', resolve));

  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const processed = await worker.runOnce();
        await worker.sweepCorrelations();
        if (processed.length > 0) continue;
      } catch {
        // error ของรอบนี้ไม่ทำให้ process ตาย; lease หมดแล้ว entry ถูกหยิบใหม่
        dependencies.log?.({ code: 'LINE_WEBHOOK_WORKER_ROUND_FAILED' });
      }
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  };
  running = loop();

  return {
    server,
    worker,
    async stop() {
      stopped = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await running;
    },
  };
}
